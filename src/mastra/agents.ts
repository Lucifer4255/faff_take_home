import { Agent } from '@mastra/core/agent'
import type { Adapter } from '@/core/adapter'
import { Intent, type Service } from '@/core/intent'

/** Mastra model-router string; OpenRouter reads OPENROUTER_API_KEY. */
export const MODEL = process.env.MODEL || 'openrouter/anthropic/claude-sonnet-4.5'

const GOALS: Record<Service, string> = {
  quickcommerce:
    'Build a checkout-ready cart for every requested item. If an item is unavailable, pick a reasonable alternative (explain why) or flag it as unavailable.',
  homeservices:
    'Reach a booking-ready slot matching the requested service, location, and time. Present the best options if the exact time is unavailable.',
  delivery:
    'Get a concrete quote for the pickup → drop route. Dispatching the ride costs real money — only via confirm.',
}

function instructions(service: Service): string {
  return [
    `You are an agent operating a ${service} app on the user's behalf.`,
    `Goal: ${GOALS[service]}`,
    '',
    'Rules:',
    '- Act through tools only; never invent ids — use only ids returned by earlier tool calls.',
    '- A tool result of {"error": ...} means the action failed; adapt or try an alternative, do not repeat the identical call.',
    '- When the goal state is reached, call get_state, then you MUST call confirm with a one-line summary (incl. total amount if known). Do not just describe the cart/slot/quote in text and stop — reaching the result without calling confirm is a failure.',
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
