import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { Adapter, AdapterTools, ToolCtx } from '@/core/adapter'

/** Zod input schemas for the shared tool surface (DESIGN.md §3). */
const SCHEMAS = {
  search_catalog: z.object({ query: z.string() }),
  resolve_location: z.object({ text: z.string() }),
  add_to_cart: z.object({
    itemId: z.string(),
    qty: z.number().int().default(1).describe('quantity, at least 1'),
  }),
  select_slot: z.object({ slotId: z.string() }),
  request_quote: z.object({ pickup: z.string(), drop: z.string() }),
  get_state: z.object({}),
  confirm: z.object({
    summary: z.string().describe('one-line summary of what will be executed, incl. total amount if known'),
  }),
} as const satisfies Record<keyof AdapterTools, z.ZodType>

const DESCRIPTIONS: Record<keyof AdapterTools, string> = {
  search_catalog: 'Search the target catalog for candidate items / services / routes',
  resolve_location: 'Geocode a messy address to coordinates + confidence',
  add_to_cart: 'Add an item (by id from a prior search) to the cart',
  select_slot: 'Select an availability slot (by id from a prior search)',
  request_quote: 'Get a price quote for a pickup → drop route',
  get_state: 'Read the current cart / slot / ride state',
  confirm: 'Execute the irreversible action (place order / book / dispatch). Requires human approval.',
}

/** The stable per-run key (cart, idempotency) is forwarded from the stream via
 * requestContext; fall back defensively so a missing context never crashes. */
export function sessionIdFrom(ctx: unknown): string {
  const c = ctx as { requestContext?: { get?(k: string): unknown; sessionId?: unknown }; threadId?: string; runId?: string }
  const fromReq = c?.requestContext?.get?.('sessionId') ?? c?.requestContext?.sessionId
  return String(fromReq ?? c?.threadId ?? c?.runId ?? 'default')
}

/**
 * Wrap an adapter's tool implementations as Mastra tools. `confirm` is marked
 * `requireApproval: true` so the agent stream pauses at a `tool-call-approval`
 * chunk before executing — that pause IS the EXECUTE gate (DESIGN.md §5),
 * snapshot-backed so it survives a restart.
 */
export function buildTools(adapter: Adapter): Record<string, ReturnType<typeof createTool>> {
  const tools: Record<string, ReturnType<typeof createTool>> = {}
  for (const name of Object.keys(adapter.tools) as (keyof AdapterTools)[]) {
    const impl = adapter.tools[name]
    if (!impl) continue
    tools[name] = createTool({
      id: name,
      description: DESCRIPTIONS[name],
      inputSchema: SCHEMAS[name],
      ...(name === 'confirm' ? { requireApproval: true } : {}),
      execute: async (input: unknown, ctx: unknown) => {
        const toolCtx: ToolCtx = { sessionId: sessionIdFrom(ctx) }
        return (impl as (i: unknown, c: ToolCtx) => Promise<unknown>)(input, toolCtx)
      },
    })
  }
  return tools
}
