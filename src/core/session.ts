import { randomUUID } from 'node:crypto'
import { RequestContext } from '@mastra/core/di'
import { interpret } from '@/mastra/agents'
import { adapterFor, controllerAgent } from '@/mastra/index'
import type { AgentEvent } from './events'
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
  private pending: 'approval' | 'location-area' | 'location-pick' | 'login-phone' | 'login-otp' | null = null
  private pendingIntent?: Intent
  private locationCandidates: Array<{ ref: string; label: string; area?: string }> = []
  private loginPhone?: string
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
  async run(input: { text: string; address?: string; location?: { lat: number; lon: number }; userId?: string }): Promise<void> {
    try {
      this.requestText = input.text
      if (input.userId) this.userId = input.userId
      this.emit({ type: 'action', label: 'Interpreting request' })
      const intent = await interpret(input.text, input.address)
      this.emit({ type: 'state_update', state: { intent } })
      this.service = intent.service
      this.agent = controllerAgent(intent.service)
      this.emit({ type: 'agent_message', text: `Routed to the ${intent.service} adapter.` })

      // Pin a client-captured location (web-UI geolocation / CLI flag) before the
      // agent drives a location-first target. Adapters that don't need it ignore.
      const canLocate = Boolean(adapterFor(intent.service)?.configureLocation)
      let located = false
      if (input.location) {
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
      if (canLocate && !located && !alreadyLocated && adapter?.suggestLocations) {
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
        ]),
        maxSteps: 25,
      })
      await this.pump(stream)
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
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
    // own account): phone → OTP → then the deferred approval executes.
    if (this.pending === 'login-phone') {
      this.pending = null
      const adapter = adapterFor(this.service ?? '')
      this.emit({ type: 'action', label: 'Sending OTP…' })
      const res = (await adapter?.sendLoginCode?.(text.trim())) ?? { ok: false, error: 'login unavailable' }
      if (!res.ok) {
        this.emit({ type: 'agent_message', text: res.error ?? "Couldn't send the OTP." })
        this.askForPhone()
        return
      }
      this.loginPhone = text.trim()
      this.pending = 'login-otp'
      this.emit({ type: 'question', text: 'Enter the OTP sent to your phone.' })
      return
    }
    if (this.pending === 'login-otp') {
      this.pending = null
      const adapter = adapterFor(this.service ?? '')
      if (/^resend$/i.test(text.trim())) {
        await adapter?.sendLoginCode?.(this.loginPhone ?? '')
        this.pending = 'login-otp'
        this.emit({ type: 'question', text: 'OTP re-sent. Enter it.' })
        return
      }
      this.emit({ type: 'action', label: 'Verifying OTP…' })
      const res = (await adapter?.verifyLoginCode?.(this.userId, this.loginPhone ?? '', text.trim())) ?? { ok: false, error: 'login unavailable' }
      if (!res.ok) {
        this.emit({ type: 'agent_message', text: res.error ?? "That OTP didn't work." })
        this.pending = 'login-otp'
        this.emit({ type: 'question', text: 'Re-enter the OTP (or type "resend").' })
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
      this.emit({ type: 'agent_message', text: 'To place this in your Blinkit cart, log in once.' })
      this.askForPhone()
      return
    }
    await this.doApprove()
  }

  /** Ask for the login phone number (parked before executing the gate). */
  private askForPhone(): void {
    this.pending = 'login-phone'
    this.emit({ type: 'question', text: 'What mobile number is your Blinkit account on? (10 digits)' })
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
      this.emit({ type: 'done', summary: 'complete' })
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
        const url = (result as { checkoutUrl?: string })?.checkoutUrl
        if (typeof url === 'string') this.turnCheckoutUrl = url
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
