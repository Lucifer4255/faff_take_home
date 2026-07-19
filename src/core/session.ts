import { randomUUID } from 'node:crypto'
import { RequestContext } from '@mastra/core/di'
import { interpret } from '@/mastra/agents'
import { adapterFor, controllerAgent } from '@/mastra/index'
import type { AgentEvent } from './events'
import { geocodeAddress } from './geocode'
import type { Intent } from './intent'
import { JsonStore } from './store'

type Listener = (event: AgentEvent) => void

const APPROVE = /^(confirm|yes|y|approve|ok|go)$/i

/**
 * Durable gate checkpoint (DESIGN.md §5): when a run parks at the EXECUTE gate
 * we record enough to resume it after a process restart — the Mastra runId
 * (its snapshot, incl. requestContext, lives in libSQL) plus the service and a
 * display summary. Cleared when the run finishes.
 */
interface GateCheckpoint {
  runId: string
  service: string
  summary: string
  amount?: number
}
const gateStore = new JsonStore<GateCheckpoint>('.data/gates.json')

/**
 * One session = one run of the pipeline. Bridges Mastra's agent stream to the
 * typed event union (DESIGN.md §4): it pumps `fullStream` chunks into events,
 * and parks at the native tool-approval (`tool-call-approval`) — the EXECUTE
 * gate — until an approve/decline arrives over POST /message, which resumes the
 * run via approveToolCall/declineToolCall (a fresh stream it keeps pumping).
 */
export class Session {
  readonly id: string
  private readonly events: AgentEvent[] = []
  private readonly listeners = new Set<Listener>()
  // biome-ignore lint: Mastra's Agent/stream types are structural; kept loose at this boundary
  private agent: any
  private service?: string
  private userId = 'anon'
  private runId?: string
  private pending: 'approval' | 'location-area' | 'location-pick' | 'login-phone' | 'login-otp' | 'tracking' | null = null
  private pendingIntent?: Intent
  private lastIntent?: Intent
  // A custom delivery address set this session (UI bar / request) — forwarded to
  // tools via requestContext so confirm books the right saved address.
  private deliveryAddressText?: string
  private locationCandidates: Array<{ ref: string; label: string; area?: string }> = []
  private loginPhone?: string
  // Set when a confirm result reports a real dispatch, so pump() starts live
  // tracking; `stopTracking` breaks the observe loop when the user cancels.
  private dispatched = false
  private stopTracking = false
  private loginPollActive = false
  private requestText = ''
  private textBuf = ''
  private finished = false
  // Checkout link produced during the CURRENT turn (reset each turn) — re-surfaced
  // at turn end so the cart link is always in the output when a cart was touched,
  // without repeating it on unrelated turns ("thanks").
  private turnCheckoutUrl?: string

  constructor(id: string = randomUUID()) {
    this.id = id
  }

  /**
   * Rebuild a session for a gate checkpoint left on disk by a prior process
   * (server restart). Its agent loop is gone; it exists to let a reconnecting
   * client see the pending gate and approve/decline it — the resume runs against
   * the Mastra snapshot in libSQL. Returns null if no checkpoint for this id.
   */
  static recover(id: string): Session | null {
    const cp = gateStore.get(id)
    if (!cp) return null
    const session = new Session(id)
    session.service = cp.service
    session.agent = controllerAgent(cp.service)
    session.runId = cp.runId
    session.pending = 'approval'
    session.emit({
      type: 'agent_message',
      text: 'Recovered a pending confirmation after a restart. Approve to complete it, or cancel.',
    })
    session.emit({ type: 'awaiting_confirmation', summary: cp.summary, amount: cp.amount, currency: 'INR' })
    return session
  }

  emit(event: AgentEvent): void {
    this.events.push(event)
    for (const listener of this.listeners) listener(event)
    // A turn ending ('done') resolves any gate but keeps the session OPEN for the
    // next message — a session is a multi-turn conversation now. Only an error is
    // terminal.
    if (event.type === 'done') gateStore.delete(this.id)
    if (event.type === 'error') {
      this.finished = true
      gateStore.delete(this.id)
    }
  }

  /** Subscribe with full replay; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    for (const event of this.events) listener(event)
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get isFinished(): boolean {
    return this.finished
  }

  /** Interpret the request, route to the service agent, and pump its stream. */
  async run(input: { text: string; address?: string; deliveryAddress?: string; location?: { lat: number; lon: number }; userId?: string }): Promise<void> {
    try {
      this.requestText = input.text
      if (input.userId) this.userId = input.userId
      this.emit({ type: 'action', label: 'Interpreting request' })
      const intent = await interpret(input.text, input.address)
      this.lastIntent = intent
      this.emit({ type: 'state_update', state: { intent } })
      this.service = intent.service
      this.agent = controllerAgent(intent.service)
      this.emit({ type: 'agent_message', text: `Routed to the ${intent.service} adapter.` })

      // Pin a client-captured location (web-UI geolocation / CLI flag) before the
      // agent drives a location-first target. Adapters that don't need it ignore.
      const canLocate = Boolean(adapterFor(intent.service)?.configureLocation)
      let located = false
      // A custom delivery address from the UI wins over GPS (the whole point —
      // let the user order to somewhere other than where they're standing).
      const deliveryAddr = input.deliveryAddress?.trim()
      if (deliveryAddr && canLocate) {
        located = await this.setDeliveryArea(deliveryAddr)
      } else if (input.location) {
        const adapter = adapterFor(intent.service)
        if (adapter?.configureLocation) {
          this.emit({ type: 'action', label: 'Setting delivery location' })
          try {
            const { label, serviceable } = await adapter.configureLocation(input.location.lat, input.location.lon)
            located = serviceable !== false
            this.emit({
              type: 'agent_message',
              text: label
                ? `Delivering to ${label}${serviceable === false ? ' (⚠ not serviceable here)' : ''}.`
                : `Using your location (${input.location.lat.toFixed(4)}, ${input.location.lon.toFixed(4)}).`,
            })
          } catch (err) {
            this.emit({ type: 'agent_message', text: `Couldn't set your location (${err instanceof Error ? err.message : err}); using the default.` })
          }
        }
      }

      // If no location is known and the target needs one (headless has no GPS),
      // establish it with the user BEFORE the agent runs — parking for input like
      // the gate does. Once pinned, the agent just searches. Adapters without
      // suggestLocations (e.g. the mock) skip straight to the agent.
      const adapter = adapterFor(intent.service)
      const alreadyLocated = adapter?.hasLocation?.() ?? false
      if (canLocate && !located && !alreadyLocated && !deliveryAddr && adapter?.suggestLocations) {
        this.pendingIntent = intent
        const area = intent.service === 'quickcommerce' ? intent.address.trim() : ''
        if (area) await this.resolveArea(area)
        else this.askForArea()
        return // parked; the agent starts once a location is pinned
      }

      await this.startAgent(intent)
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Start the controller agent for the FIRST turn once a location is settled.
   * The agent gets the user's ACTUAL words (to gauge ask-vs-order) plus the
   * parsed intent as a hint. Memory keyed by the session id (thread). */
  private async startAgent(intent: Intent): Promise<void> {
    await this.streamTurn(`User request: "${this.requestText}"\n\nParsed hint (may over-assume an order): ${JSON.stringify(intent)}`)
  }

  /** A follow-up conversational turn — just the user's text; memory carries the
   * prior turns (incl. the products already shown), so "add the Nandini" works. */
  private async startTurn(text: string): Promise<void> {
    this.emit({ type: 'action', label: 'Thinking' })
    await this.streamTurn(text)
  }

  private async streamTurn(message: string): Promise<void> {
    try {
      const stream = await this.agent.stream(message, {
        memory: { thread: this.id, resource: this.userId },
        requestContext: new RequestContext([
          ['sessionId', this.id],
          ['userId', this.userId],
          ['deliveryAddress', this.deliveryAddressText ?? ''],
        ]),
        maxSteps: 25,
      })
      await this.pump(stream)
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Set/override the delivery address from the UI — a CUSTOM address, not GPS.
   * Blinkit resolves via its own place-search + pin; UC (and other
   * configureLocation-only targets) geocode the free text (Nominatim) then pin the
   * coords. Emits a confirmation + a `deliverTo` state_update (updates the bar).
   * Returns whether the resolved place is serviceable. */
  async setDeliveryArea(text: string): Promise<boolean> {
    const adapter = adapterFor(this.service ?? '')
    if (!adapter?.configureLocation && !adapter?.suggestLocations) {
      this.emit({ type: 'agent_message', text: this.service ? 'This service uses a fixed location — no custom address needed.' : 'Tell me what to order first, then I can set a delivery address.' })
      return false
    }
    this.emit({ type: 'action', label: `Setting delivery address: ${text}` })
    // Remember it so tools (confirm) can pick the right saved address.
    this.deliveryAddressText = text
    try {
      if (adapter.suggestLocations && adapter.pinLocation) {
        const cands = await adapter.suggestLocations(text)
        if (!cands.length) {
          this.emit({ type: 'agent_message', text: `Couldn't find "${text}" — try a more specific address.` })
          return false
        }
        const r = await adapter.pinLocation(cands[0].ref)
        const label = r.label ?? cands[0].label
        this.emit({ type: 'agent_message', text: `📍 Delivering to ${label}${r.serviceable === false ? ' (⚠ may not be serviceable here)' : ''}.` })
        this.emit({ type: 'state_update', state: { deliverTo: { address: label } } })
        return r.serviceable !== false
      }
      // configureLocation-only (e.g. UC): geocode the address → pin the coords.
      const hit = await geocodeAddress(text)
      if (!hit) {
        this.emit({ type: 'agent_message', text: `Couldn't find "${text}" — try a more specific address.` })
        return false
      }
      const r = await adapter.configureLocation!(hit.lat, hit.lon)
      const label = r.label ?? hit.formattedAddress
      this.emit({ type: 'agent_message', text: `📍 Delivering to ${label}${r.serviceable === false ? ' (⚠ not serviceable here)' : ''}.` })
      this.emit({ type: 'state_update', state: { deliverTo: { address: label } } })
      return r.serviceable !== false
    } catch (e) {
      this.emit({ type: 'agent_message', text: `Couldn't set that address (${e instanceof Error ? e.message : e}).` })
      return false
    }
  }

  /** Ask the user for a delivery area (geolocation denied / not provided). */
  private askForArea(): void {
    this.pending = 'location-area'
    this.emit({ type: 'question', text: 'What area should this deliver to? (e.g. "Koramangala, Bengaluru")' })
  }

  /** Turn a free-text area into a pinned store: autocomplete → 1 pins directly,
   * many parks a pick, none re-asks. */
  private async resolveArea(text: string): Promise<void> {
    const adapter = adapterFor(this.service ?? '')
    const candidates = (await adapter?.suggestLocations?.(text)) ?? []
    if (candidates.length === 0) {
      this.emit({ type: 'agent_message', text: `I couldn't find "${text}". Try a more specific area.` })
      this.askForArea()
      return
    }
    if (candidates.length === 1) {
      await this.pinAndStart(candidates[0].ref, candidates[0].label)
      return
    }
    this.locationCandidates = candidates
    this.pending = 'location-pick'
    this.emit({ type: 'question', text: 'Which delivery location?', options: candidates.map((c) => c.label) })
  }

  /** Pin the chosen place, then start the agent with the deferred intent. */
  private async pinAndStart(ref: string, label: string): Promise<void> {
    const adapter = adapterFor(this.service ?? '')
    try {
      const { serviceable } = (await adapter?.pinLocation?.(ref)) ?? {}
      this.emit({ type: 'agent_message', text: `Delivering to ${label}${serviceable === false ? ' (⚠ not serviceable here)' : ''}.` })
    } catch (err) {
      this.emit({ type: 'agent_message', text: `Couldn't set that location (${err instanceof Error ? err.message : err}).` })
    }
    this.pending = null
    if (this.pendingIntent) await this.startAgent(this.pendingIntent)
  }

  /** Approvals, location replies, and picks arrive here from POST /message. */
  async handleMessage(text: string): Promise<void> {
    // Live-tracking a dispatched ride: "cancel" fires the post-money-line kill
    // path; anything else just reminds how to stop it.
    if (this.pending === 'tracking') {
      if (!/^(cancel|stop|abort)\b/i.test(text.trim())) {
        this.emit({ type: 'agent_message', text: 'Your ride is live — say "cancel" to call it off.' })
        return
      }
      this.stopTracking = true
      this.pending = null
      const adapter = adapterFor(this.service ?? '')
      this.emit({ type: 'action', label: 'Cancelling your ride…' })
      try {
        const r = await adapter?.cancel?.({ sessionId: this.id, userId: this.userId })
        this.emit({
          type: 'agent_message',
          text: r?.cancelled ? `✓ Ride cancelled${r.finalStatus ? ` (${r.finalStatus})` : ''}.` : `Couldn't auto-cancel (${r?.note ?? 'no cancel path'}). Please cancel in the Uber app.`,
        })
      } catch (err) {
        this.emit({ type: 'agent_message', text: `Cancel failed (${err instanceof Error ? err.message : err}) — cancel in the Uber app.` })
      }
      this.emit({ type: 'done', summary: 'cancelled' })
      return
    }
    // Establishing a delivery location (parked before the agent runs).
    if (this.pending === 'location-area') {
      this.pending = null
      await this.resolveArea(text.trim())
      return
    }
    if (this.pending === 'location-pick') {
      const q = text.trim().toLowerCase()
      const chosen =
        this.locationCandidates.find((c) => c.label.toLowerCase() === q) ??
        this.locationCandidates.find((c) => `${c.label} ${c.area ?? ''}`.toLowerCase().includes(q))
      if (!chosen) {
        this.emit({ type: 'question', text: 'Please pick one of the listed locations.', options: this.locationCandidates.map((c) => c.label) })
        return
      }
      this.pending = null
      await this.pinAndStart(chosen.ref, chosen.label)
      return
    }
    // Account login (parked after gate-approval so the order goes to the user's
    // own account): phone → sign in (in-chat OTP relay, or the adapter's own
    // out-of-band flow — see `instructions`) → then the deferred approval executes.
    if (this.pending === 'login-phone') {
      this.pending = null
      const adapter = adapterFor(this.service ?? '')
      this.emit({ type: 'action', label: 'Preparing sign-in…' })
      const res = (await adapter?.sendLoginCode?.(text.trim(), this.userId)) ?? { ok: false, error: 'login unavailable' }
      if (!res.ok) {
        this.emit({ type: 'agent_message', text: res.error ?? "Couldn't start sign-in." })
        this.askForPhone()
        return
      }
      if (res.instructions) this.emit({ type: 'agent_message', text: res.instructions })
      this.loginPhone = text.trim()
      this.pending = 'login-otp'
      // Adapters that hand back `instructions` (e.g. homeservices — see
      // auth.ts) have nothing for the user to type back at all: login happens
      // out-of-band in their own browser. Poll in the background instead of
      // waiting on a chat reply, so "done" isn't a step the user has to
      // remember — a manual reply still works too (belt and suspenders; first
      // one to land wins, guarded by `pending`/`loginPollActive` below).
      if (res.instructions) this.startLoginPoller()
      this.emit({ type: 'question', text: res.instructions ? 'Take your time — I\'ll notice once you\'re signed in.' : 'Enter the code sent to your phone.' })
      return
    }
    if (this.pending === 'login-otp') {
      this.pending = null
      this.loginPollActive = false
      const adapter = adapterFor(this.service ?? '')
      if (/^resend$/i.test(text.trim())) {
        const res = (await adapter?.sendLoginCode?.(this.loginPhone ?? '', this.userId)) ?? { ok: false, error: 'login unavailable' }
        if (res.instructions) this.emit({ type: 'agent_message', text: res.instructions })
        this.pending = 'login-otp'
        if (res.instructions) this.startLoginPoller()
        this.emit({ type: 'question', text: res.instructions ? 'Take your time — I\'ll notice once you\'re signed in.' : 'Code re-sent. Enter it.' })
        return
      }
      this.emit({ type: 'action', label: 'Checking sign-in…' })
      const res = (await adapter?.verifyLoginCode?.(this.userId, this.loginPhone ?? '', text.trim())) ?? { ok: false, error: 'login unavailable' }
      if (!res.ok) {
        this.emit({ type: 'agent_message', text: res.error ?? "That didn't work." })
        this.pending = 'login-otp'
        this.startLoginPoller()
        this.emit({ type: 'question', text: 'Reply here once you\'re signed in (or type "resend").' })
        return
      }
      this.emit({ type: 'agent_message', text: '✓ Logged in. Placing your cart…' })
      await this.doApprove() // resume the gate now that we're authenticated
      return
    }
    // Idle (a turn finished, no gate) → a new conversational turn. Memory gives
    // the agent the prior context, so the chat is a real back-and-forth.
    if (this.pending !== 'approval') {
      if (this.finished) {
        this.emit({ type: 'agent_message', text: 'This session has ended — start a new one.' })
        return
      }
      await this.startTurn(text.trim())
      return
    }
    this.pending = null
    if (!APPROVE.test(text.trim())) {
      this.emit({ type: 'action', label: 'Cancelling — nothing charged' })
      try {
        await this.pump(await this.agent.declineToolCall({ runId: this.runId }))
      } catch (err) {
        this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    // Approved. For an account-order target, log the user in FIRST (so it goes to
    // their account), then execute the gate. Guest / already-logged-in → straight through.
    const adapter = adapterFor(this.service ?? '')
    if (adapter?.needsLogin?.(this.userId)) {
      this.emit({ type: 'agent_message', text: 'To place this under your own account, log in once.' })
      this.askForPhone()
      return
    }
    await this.doApprove()
  }

  /** Ask for the login phone number (parked before executing the gate). */
  private askForPhone(): void {
    this.pending = 'login-phone'
    this.emit({ type: 'question', text: 'What mobile number is your account on? (10 digits)' })
  }

  /** Background poll for `verifyLoginCode` to succeed, replacing the need for
   * the user to type "done" once they finish an out-of-band login (see
   * homeservices/auth.ts's real-Chrome flow — there's no OTP to relay through
   * chat at all). Self-terminates on timeout, on session end, or the instant
   * `pending` moves off `'login-otp'` for any other reason (a manual reply
   * landing first, a decline, etc.) — `loginPollActive` + the `pending` check
   * make the manual and automatic paths mutually exclusive without a lock. */
  private startLoginPoller(timeoutMs = 300_000): void {
    if (this.loginPollActive) return
    this.loginPollActive = true
    const adapter = adapterFor(this.service ?? '')
    const phone = this.loginPhone ?? ''
    const deadline = Date.now() + timeoutMs
    const tick = async () => {
      if (!this.loginPollActive || this.pending !== 'login-otp' || this.finished) return
      if (Date.now() > deadline) {
        this.loginPollActive = false
        return // the manual "reply here" / "resend" path is still live
      }
      try {
        const res = await adapter?.verifyLoginCode?.(this.userId, phone, '')
        if (res?.ok && this.loginPollActive && this.pending === 'login-otp') {
          this.loginPollActive = false
          this.pending = null
          this.emit({ type: 'agent_message', text: '✓ Signed in. Placing your cart…' })
          await this.doApprove()
          return
        }
      } catch {
        /* not ready yet, or a transient error — keep polling till the deadline */
      }
      if (this.loginPollActive) setTimeout(tick, 4000)
    }
    setTimeout(tick, 4000)
  }

  /** Execute the approved gate (confirm) — runs after login is settled. */
  private async doApprove(): Promise<void> {
    this.emit({ type: 'action', label: 'Approving — executing…' })
    try {
      await this.pump(await this.agent.approveToolCall({ runId: this.runId }))
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  // biome-ignore lint: structural stream type
  private async pump(stream: any): Promise<void> {
    this.runId = stream?.runId ?? this.runId
    this.turnCheckoutUrl = undefined
    for await (const chunk of stream.fullStream) this.mapChunk(chunk)
    this.flushText()
    // If we parked at the gate, wait for the user; otherwise the turn is done.
    if (!this.pending && !this.finished) {
      // Guarantee the cart link when this turn touched the cart — independent of
      // whether the LLM remembered to include it in its own summary.
      if (this.turnCheckoutUrl) {
        const label = this.service === 'homeservices' ? '🧹 Booking-ready — open to pick your slot, sign in & confirm' : '🛒 Checkout-ready cart'
        this.emit({ type: 'agent_message', text: `${label}: ${this.turnCheckoutUrl}` })
      }
      // A real ride was just dispatched → stream live tracking instead of ending,
      // and let the user say "cancel" (the post-money-line kill path).
      const adapter = adapterFor(this.service ?? '')
      if (this.dispatched && adapter?.observe) {
        this.dispatched = false
        void this.startTracking()
        return
      }
      this.emit({ type: 'done', summary: 'complete' })
    }
  }

  /** Stream the adapter's live tracking (observe) to the UI until the ride ends
   * or the user cancels. Runs in the background — the request that started it
   * returns, and a concurrent "cancel" over POST /message flips `stopTracking`. */
  private async startTracking(): Promise<void> {
    const adapter = adapterFor(this.service ?? '')
    if (!adapter?.observe || !this.lastIntent) {
      this.emit({ type: 'done', summary: 'complete' })
      return
    }
    this.pending = 'tracking'
    this.stopTracking = false
    this.emit({ type: 'agent_message', text: 'Tracking your ride live — say "cancel" to call it off.' })
    const ctx = { sessionId: this.id, userId: this.userId }
    try {
      for await (const ev of adapter.observe(this.lastIntent, ctx)) {
        if (this.stopTracking || this.finished) break
        this.emit(ev)
      }
    } catch (err) {
      this.emit({ type: 'agent_message', text: `Tracking stopped (${err instanceof Error ? err.message : err}).` })
    }
    // Ended naturally (ride complete) — not via a cancel, which handles its own done.
    if (this.pending === 'tracking' && !this.stopTracking) {
      this.pending = null
      this.emit({ type: 'done', summary: 'ride complete' })
    }
  }

  private flushText(): void {
    const text = this.textBuf.trim()
    this.textBuf = ''
    if (text) this.emit({ type: 'agent_message', text })
  }

  // biome-ignore lint: structural chunk type
  private mapChunk(chunk: any): void {
    const p = chunk.payload ?? {}
    switch (chunk.type) {
      case 'text-delta':
        this.textBuf += p.text ?? chunk.text ?? ''
        break
      case 'text-end':
        this.flushText()
        break
      case 'tool-call':
        this.flushText()
        this.emit({ type: 'action', label: `${p.toolName} ${JSON.stringify(p.args ?? {})}` })
        break
      case 'tool-result': {
        const result = p.result ?? p
        // `null` (not just absent) explicitly clears a link an EARLIER tool
        // call this turn already set (e.g. select_slot's guest-style link,
        // superseded by confirm's authenticated result, which has no
        // equivalent shareable link — see homeservices/index.ts's confirm).
        const url = (result as { checkoutUrl?: string | null })?.checkoutUrl
        if (typeof url === 'string') this.turnCheckoutUrl = url
        else if (url === null) this.turnCheckoutUrl = undefined
        // A real ride was dispatched (delivery confirm) → pump() will start live
        // tracking once the stream settles, instead of ending the turn.
        if ((result as { status?: string })?.status === 'dispatched') this.dispatched = true
        this.emit({ type: 'state_update', state: result })
        break
      }
      case 'tool-call-approval': {
        this.flushText()
        this.pending = 'approval'
        this.runId = chunk.runId ?? p.runId ?? this.runId
        const summary: string = p.args?.summary ?? 'Confirm this action?'
        const amount = parseAmount(summary)
        // Persist the checkpoint BEFORE emitting, so an approval still completes
        // if the process dies here (DESIGN.md §5, restart-durable gate).
        if (this.runId && this.service) {
          gateStore.set(this.id, { runId: this.runId, service: this.service, summary, amount })
        }
        this.emit({ type: 'awaiting_confirmation', summary, amount, currency: 'INR' })
        break
      }
      case 'tool-call-suspended':
        this.flushText()
        this.emit({ type: 'question', text: p.question ?? p.suspendPayload?.question ?? 'Input needed', options: p.options })
        break
      case 'error':
        this.emit({ type: 'error', message: String(p.error ?? p.message ?? 'stream error') })
        break
      default:
        break
    }
  }
}

function parseAmount(summary: string): number | undefined {
  const m = summary.match(/₹\s*([\d,]+)/)
  if (!m) return undefined
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/**
 * In-process session registry. Stashed on globalThis so it survives Next.js dev
 * per-route module re-evaluation (each route compiling on first hit would
 * otherwise get its own empty Map and lose sessions created by another route).
 */
const globalForSessions = globalThis as unknown as { __faffSessions?: Map<string, Session> }
export const sessions: Map<string, Session> = (globalForSessions.__faffSessions ??= new Map())

/** Look up a live session, or rebuild one from a persisted gate checkpoint after
 * a server restart (DESIGN.md §5). */
export function getOrRecover(id: string): Session | undefined {
  const existing = sessions.get(id)
  if (existing) return existing
  const recovered = Session.recover(id)
  if (recovered) sessions.set(id, recovered)
  return recovered ?? undefined
}
