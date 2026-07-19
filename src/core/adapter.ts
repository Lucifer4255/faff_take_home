import type { AgentEvent } from './events'
import type { Intent, Service } from './intent'

/** Context every tool implementation receives. `sessionId` is the stable per-run
 * key (cart, idempotency) — forwarded from the stream via requestContext. */
export interface ToolCtx {
  sessionId: string
  /** Stable per-user id (from the client) — keys the user's account/login so
   * many users share the app without cart/account collisions. */
  userId: string
  /** A custom delivery address the user set (UI bar / session), if any — used to
   * disambiguate which saved address to book to (e.g. two "Home" addresses). */
  deliveryAddress?: string
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
  /** Remove an item (or `qty` of it) from the cart — enables replacing items. */
  remove_from_cart?: Impl<{ itemId: string; qty?: number }>
  select_slot?: Impl<{ slotId: string; address?: string }>
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
  /** Cancel an active post-confirm operation (a dispatched ride) — the KILL PATH
   * for after the money line is crossed. Optional; only delivery implements it. */
  cancel?(ctx: ToolCtx): Promise<{ cancelled: boolean; finalStatus?: string; note: string }>
  /** Pin a real-world location (lat/lon) captured by the client (web-UI browser
   * geolocation, CLI flag) before the run drives the target. Location-first
   * targets (quick-commerce dark stores, delivery pickup) use it; others ignore.
   * Returns a short human label of where it resolved, for display. */
  configureLocation?(lat: number, lon: number): Promise<{ label?: string; serviceable?: boolean }>
  /** Whether a delivery location is already established (persisted/env), so the
   * harness needn't ask the user to set one. Cheap/sync. */
  hasLocation?(): boolean
  /** Autocomplete a free-text area → candidate places (the geolocation-denied
   * fallback). Each `ref` is an opaque id passed back to pinLocation. */
  suggestLocations?(text: string): Promise<Array<{ ref: string; label: string; area?: string }>>
  /** Pin a candidate place chosen by the user (by its `ref`). */
  pinLocation?(ref: string): Promise<{ label?: string; serviceable?: boolean }>
  /** Per-user account login (browser-assisted OTP), so an order can go under the
   * user's own account. Optional — guest-only adapters omit these. */
  needsLogin?(userId: string): boolean
  /** `instructions`, if present, is shown to the user before the harness asks
   * its follow-up question — e.g. a command to run in their own terminal, for
   * adapters where login can't be driven by us at all (see homeservices/auth.ts). */
  sendLoginCode?(phone: string, userId?: string): Promise<{ ok: boolean; error?: string; instructions?: string }>
  verifyLoginCode?(userId: string, phone: string, code: string): Promise<{ ok: boolean; error?: string }>
}
