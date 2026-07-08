import { randomUUID } from 'node:crypto'
import { RequestContext } from '@mastra/core/di'
import { interpret } from '@/mastra/agents'
import { controllerAgent } from '@/mastra/index'
import type { AgentEvent } from './events'

type Listener = (event: AgentEvent) => void

const APPROVE = /^(confirm|yes|y|approve|ok|go)$/i

/**
 * One session = one run of the pipeline. Bridges Mastra's agent stream to the
 * typed event union (DESIGN.md §4): it pumps `fullStream` chunks into events,
 * and parks at the native tool-approval (`tool-call-approval`) — the EXECUTE
 * gate — until an approve/decline arrives over POST /message, which resumes the
 * run via approveToolCall/declineToolCall (a fresh stream it keeps pumping).
 */
export class Session {
  readonly id = randomUUID()
  private readonly events: AgentEvent[] = []
  private readonly listeners = new Set<Listener>()
  // biome-ignore lint: Mastra's Agent/stream types are structural; kept loose at this boundary
  private agent: any
  private runId?: string
  private pending: 'approval' | null = null
  private textBuf = ''
  private finished = false

  emit(event: AgentEvent): void {
    this.events.push(event)
    for (const listener of this.listeners) listener(event)
    if (event.type === 'done' || event.type === 'error') this.finished = true
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
  async run(input: { text: string; address?: string }): Promise<void> {
    try {
      this.emit({ type: 'action', label: 'Interpreting request' })
      const intent = await interpret(input.text, input.address)
      this.emit({ type: 'state_update', state: { intent } })
      this.agent = controllerAgent(intent.service)
      this.emit({ type: 'agent_message', text: `Routed to the ${intent.service} adapter.` })

      const stream = await this.agent.stream(
        `Typed intent (already parsed from the user's request):\n${JSON.stringify(intent, null, 2)}`,
        { requestContext: new RequestContext([['sessionId', this.id]]), maxSteps: 25 },
      )
      await this.pump(stream)
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Approvals / replies arrive here from POST /sessions/:id/message. */
  async handleMessage(text: string): Promise<void> {
    if (this.pending !== 'approval') {
      this.emit({ type: 'agent_message', text: 'Nothing is pending right now.' })
      return
    }
    this.pending = null
    const approved = APPROVE.test(text.trim())
    this.emit({ type: 'action', label: approved ? 'Approving — executing…' : 'Cancelling — nothing charged' })
    try {
      const next = approved
        ? await this.agent.approveToolCall({ runId: this.runId })
        : await this.agent.declineToolCall({ runId: this.runId })
      await this.pump(next)
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  // biome-ignore lint: structural stream type
  private async pump(stream: any): Promise<void> {
    this.runId = stream?.runId ?? this.runId
    for await (const chunk of stream.fullStream) this.mapChunk(chunk)
    this.flushText()
    // If we parked at the gate, wait for the user; otherwise the run is done.
    if (!this.pending && !this.finished) this.emit({ type: 'done', summary: 'complete' })
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
      case 'tool-result':
        this.emit({ type: 'state_update', state: p.result ?? p })
        break
      case 'tool-call-approval': {
        this.flushText()
        this.pending = 'approval'
        this.runId = chunk.runId ?? p.runId ?? this.runId
        const summary: string = p.args?.summary ?? 'Confirm this action?'
        const amount = parseAmount(summary)
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
