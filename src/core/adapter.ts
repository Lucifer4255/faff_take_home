import type { AgentEvent } from './events'
import type { Intent, Service } from './intent'

/** Context every tool implementation receives. `sessionId` is the stable per-run
 * key (cart, idempotency) — forwarded from the stream via requestContext. */
export interface ToolCtx {
  sessionId: string
}

type Impl<I> = (input: I, ctx: ToolCtx) => Promise<unknown>

/**
 * The shared constrained tool surface (DESIGN.md §3). An adapter implements the
 * subset its target supports; `confirm` is mandatory and always rides behind
 * the EXECUTE gate (Mastra tool approval). The harness wraps each impl in a
 * Mastra `createTool()`.
 */
export interface AdapterTools {
  search_catalog?: Impl<{ query: string }>
  resolve_location?: Impl<{ text: string }>
  add_to_cart?: Impl<{ itemId: string; qty: number }>
  select_slot?: Impl<{ slotId: string }>
  request_quote?: Impl<{ pickup: string; drop: string }>
  get_state?: Impl<Record<string, never>>
  /** crosses the EXECUTE gate — the only path to an irreversible action */
  confirm: Impl<{ summary: string }>
}

export type ToolName = keyof AdapterTools

/**
 * One target = one adapter (DESIGN.md §2). Interpret is shared; each adapter
 * supplies Resolve/Drive as tool implementations and Observe as an event
 * stream. A 4th app = another one of these.
 */
export interface Adapter {
  service: Service
  tools: AdapterTools
  /** Observe: poll/stream state back after confirm (ride tracking, booking
   * status, order state). Optional until the target reaches that stage. */
  observe?(intent: Intent, ctx: ToolCtx): AsyncIterable<AgentEvent>
}
