import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent } from '@mastra/core/agent'
import { LibSQLStore } from '@mastra/libsql'
import { Memory } from '@mastra/memory'
import type { Adapter } from '@/core/adapter'
import { Intent, type Service } from '@/core/intent'

/** Mastra model-router string; OpenRouter reads OPENROUTER_API_KEY. */
export const MODEL = process.env.MODEL || 'openrouter/anthropic/claude-sonnet-4.5'

// Resolved relative to THIS file, not process.cwd() — see the matching note in
// mastra/index.ts (`mastra dev`'s bundled server runs with a different cwd,
// which would otherwise silently point this at a fresh, empty DB). Uses
// `path` math off `fileURLToPath(import.meta.url)` rather than
// `new URL('../..', import.meta.url)` — webpack statically intercepts the
// latter for asset bundling and fails on a pure `..` traversal.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Conversation memory so a session is a real back-and-forth: the agent recalls
 * prior turns (incl. tool results — the products it just showed) when the user
 * follows up ("add the Nandini"). Message-history only — no vector store /
 * embedder (semanticRecall off), so it needs no extra services. Keyed by the
 * Session's id as the thread (see core/session.ts). */
const conversationMemory = new Memory({
  storage: new LibSQLStore({ id: 'faff-memory', url: process.env.MASTRA_MEMORY_URL || `file:${path.join(projectRoot, '.data/memory.db')}` }),
  options: { lastMessages: 30, semanticRecall: false, workingMemory: { enabled: false } },
})

const GOALS: Record<Service, string> = {
  quickcommerce:
    'Help the user with groceries on Blinkit — answer questions and compare options when they are exploring, and build a checkout-ready cart when they want to order.',
  homeservices:
    'Reach a booking-ready slot matching the requested service, location, and time. Present the best options if the exact time is unavailable.',
  delivery:
    'Get a concrete quote for the pickup → drop route. Dispatching the ride costs real money — only via confirm.',
}

const COMMON = [
  '- Act through tools only; never invent ids — use only ids returned by earlier tool calls.',
  '- A tool result of {"error": ...} means the action failed; adapt or try an alternative, do not repeat the identical call.',
]

function instructions(service: Service): string {
  if (service === 'quickcommerce') {
    // Conversational + intent-driven — do NOT force an order. The delivery
    // location is already pinned by the harness before you run.
    return [
      "You are a helpful grocery shopping assistant operating Blinkit on the user's behalf.",
      `Goal: ${GOALS.quickcommerce}`,
      '',
      'Rules:',
      ...COMMON,
      '- First, read what the user actually wants:',
      '  • ASKING / EXPLORING (e.g. "what are the cheap milk options?", "which brown bread is healthiest?", "do you have paneer?", "compare X and Y"): search, then ANSWER — present the relevant options as a short list (name — size — ₹price — in/out of stock), with a brief take if they asked for "cheapest"/"best". Do NOT add anything to the cart and do NOT confirm. End by offering to add something.',
      '  • ORDERING (e.g. "get me…", "add…", "order…", "buy…", "I need…"): build a checkout-ready cart — search each item, add_to_cart the best match (pick a reasonable alternative or flag unavailable), then get_state and confirm.',
      '  • AMBIGUOUS: ask one short clarifying question instead of assuming.',
      '- search_catalog with the concise product term only (e.g. "milk", "brown bread") — never put quantities/sizes/units in the query (they match poorly). Choose the right size from the results; set the amount at add_to_cart.',
      '- An empty search result ([]) means no product matched that term — rephrase and retry; it does NOT mean the location is unavailable.',
      '- To change the cart: add_to_cart to add, remove_from_cart to drop (or reduce qty). To REPLACE an item, remove_from_cart the old one and add_to_cart the new one.',
      '- confirm places the order and needs human approval — only call it when the user wants to order. If declined, ask what to change; never retry confirm unchanged.',
      '- Whenever you present or finalize a cart, include the checkout link (checkoutUrl, e.g. https://blinkit.com/cart).',
      '- Keep replies concise.',
    ].join('\n')
  }
  if (service === 'homeservices') {
    return [
      "You are a helpful home-services booking assistant operating Urban Company on the user's behalf.",
      `Goal: ${GOALS.homeservices}`,
      '',
      'Rules:',
      ...COMMON,
      '- search_catalog for the same general need (e.g. "full house cleaning") can return SEVERAL packages that differ meaningfully in scope and price, not just size/duration variants — e.g. a full-apartment package vs. a "partial"/"by-room" build-your-own combo vs. an unfurnished-home variant. Read each result\'s name carefully; do not assume the first or cheapest result matches what was asked.',
      '- If one result\'s name clearly and specifically matches the request\'s scope (e.g. "full home cleaning" → a package literally named "…Home deep cleaning", not "Partial home cleaning"), select it directly. Otherwise, list the 2-4 most relevant distinct options (name — price — one-line scope) and ask which one before calling select_slot — do not silently guess.',
      '- When the goal state is reached, call get_state, then you MUST call confirm with a one-line summary (incl. total amount if known). Do not just describe the slot/quote in text and stop.',
      '- confirm requires human approval before it runs. If it is declined, ask what to change or wrap up — never retry confirm unchanged.',
      '- After confirm completes (approved or declined), finish with a short plain-text summary.',
    ].join('\n')
  }
  // Transactional services — reach the goal state, then confirm.
  return [
    `You are an agent operating a ${service} app on the user's behalf.`,
    `Goal: ${GOALS[service]}`,
    '',
    'Rules:',
    ...COMMON,
    '- When the goal state is reached, call get_state, then you MUST call confirm with a one-line summary (incl. total amount if known). Do not just describe the slot/quote in text and stop.',
    '- confirm requires human approval before it runs. If it is declined, ask what to change or wrap up — never retry confirm unchanged.',
    '- After confirm completes (approved or declined), finish with a short plain-text summary.',
  ].join('\n')
}

/** The controller agent for one adapter — the bounded ReAct loop (DESIGN.md §3). */
export function buildAgent(adapter: Adapter): Agent {
  return new Agent({
    id: `${adapter.service}-agent`,
    name: `${adapter.service} controller`,
    instructions: instructions(adapter.service),
    model: MODEL,
    tools: buildToolsFor(adapter),
    memory: conversationMemory,
  })
}

// imported lazily to keep this module import-cycle-free
import { buildTools } from './tools'
function buildToolsFor(adapter: Adapter) {
  return buildTools(adapter)
}

/** Interpret (DESIGN.md §2): free text → typed intent, shared across services. */
export const interpreter = new Agent({
  id: 'interpreter',
  name: 'Interpreter',
  instructions: [
    'Parse the user request into a typed intent for exactly one service:',
    '- quickcommerce: ordering groceries/products for delivery (Blinkit)',
    '- homeservices: booking a helper/cleaner/service visit (Urban Company / Snabbit)',
    '- delivery: sending a package from a pickup point to a drop point (Rapido / Porter)',
  ].join('\n'),
  model: MODEL,
})

export async function interpret(text: string, address?: string): Promise<Intent> {
  const res = await interpreter.generate(
    [text, address ? `Default address: ${address}` : ''].filter(Boolean).join('\n'),
    { structuredOutput: { schema: Intent } },
  )
  const object = (res as { object?: unknown }).object
  return Intent.parse(object)
}
