'use client'

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'

type Item =
  | { kind: 'bubble'; who: 'agent' | 'user'; text: string }
  | { kind: 'action'; label: string }
  | { kind: 'state'; state: unknown }
  | { kind: 'question'; text: string; options?: string[]; answered?: boolean }
  | { kind: 'gate'; summary: string; amount?: number; currency?: string; done?: boolean }
  | { kind: 'status'; variant: 'done' | 'error'; text: string }

const EVENT_TYPES = [
  'agent_message',
  'action',
  'state_update',
  'question',
  'awaiting_confirmation',
  'done',
  'error',
] as const

export default function Chat() {
  const [items, setItems] = useState<Item[]>([])
  const [awaiting, setAwaiting] = useState(false)
  const [finished, setFinished] = useState(false)
  const [input, setInput] = useState('')
  const sessionId = useRef<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const push = useCallback((item: Item) => setItems((prev) => [...prev, item]), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every item change
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [items])

  const send = useCallback(
    async (text: string) => {
      const id = sessionId.current
      if (!id) return
      push({ kind: 'bubble', who: 'user', text })
      setAwaiting(false)
      await fetch(`/api/sessions/${id}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
    },
    [push],
  )

  const handle = useCallback(
    (ev: { type: string; [k: string]: unknown }) => {
      switch (ev.type) {
        case 'agent_message':
          push({ kind: 'bubble', who: 'agent', text: String(ev.text) })
          break
        case 'action':
          push({ kind: 'action', label: String(ev.label) })
          break
        case 'state_update':
          push({ kind: 'state', state: ev.state })
          break
        case 'question':
          setAwaiting(true)
          push({ kind: 'question', text: String(ev.text), options: ev.options as string[] | undefined })
          break
        case 'awaiting_confirmation':
          setAwaiting(true)
          push({
            kind: 'gate',
            summary: String(ev.summary),
            amount: ev.amount as number | undefined,
            currency: (ev.currency as string) ?? 'INR',
          })
          break
        case 'done':
          setFinished(true)
          push({ kind: 'status', variant: 'done', text: String(ev.summary ?? 'done') })
          break
        case 'error':
          setFinished(true)
          push({ kind: 'status', variant: 'error', text: String(ev.message) })
          break
      }
    },
    [push],
  )

  const start = useCallback(
    async (text: string) => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const { sessionId: id } = (await res.json()) as { sessionId: string }
      sessionId.current = id
      const es = new EventSource(`/api/sessions/${id}/stream`)
      for (const t of EVENT_TYPES) {
        es.addEventListener(t, (m) => handle(JSON.parse((m as MessageEvent).data)))
      }
      es.addEventListener('error', () => es.close())
    },
    [handle],
  )

  const onSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      const text = input.trim()
      if (!text) return
      setInput('')
      if (!sessionId.current) {
        push({ kind: 'bubble', who: 'user', text })
        await start(text)
      } else {
        await send(text)
      }
    },
    [input, push, send, start],
  )

  return (
    <>
      <div id="log" ref={logRef}>
        {items.map((it, i) => (
          <Row key={i} item={it} send={send} />
        ))}
      </div>
      <footer>
        <form onSubmit={onSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={finished}
            placeholder={
              finished
                ? 'session finished — reload to start again'
                : awaiting
                  ? 'type your reply…'
                  : 'e.g. "get me 2L milk and bread to Koramangala 5th block"'
            }
            autoComplete="off"
          />
          <button className="primary" type="submit" disabled={finished}>
            Send
          </button>
        </form>
      </footer>
    </>
  )
}

function Row({ item, send }: { item: Item; send: (text: string) => void }) {
  switch (item.kind) {
    case 'bubble':
      return (
        <div className={`row ${item.who}`}>
          <div className="bubble">{item.text}</div>
        </div>
      )
    case 'action':
      return <div className="action">… {item.label}</div>
    case 'state':
      return <StateCard state={item.state} />
    case 'question':
      return (
        <div>
          <div className="row agent">
            <div className="bubble">{item.text}</div>
          </div>
          {item.options?.length ? (
            <div className="btns">
              {item.options.map((o) => (
                <button key={o} onClick={() => send(o)} type="button">
                  {o}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )
    case 'gate':
      return <Gate item={item} send={send} />
    case 'status':
      return <div className={`status ${item.variant}`}>{item.variant === 'done' ? '✓ ' : '✗ '}{item.text}</div>
  }
}

function Gate({
  item,
  send,
}: {
  item: Extract<Item, { kind: 'gate' }>
  send: (text: string) => void
}) {
  const [done, setDone] = useState(false)
  const act = (choice: string) => {
    setDone(true)
    send(choice)
  }
  return (
    <div className="gate">
      <div className="label">⚠ Execute gate — confirm to proceed</div>
      {item.amount != null ? (
        <div className="amt">
          ₹{item.amount} {item.currency}
        </div>
      ) : null}
      <div>{item.summary}</div>
      <div className="btns">
        <button className="primary" disabled={done} onClick={() => act('confirm')} type="button">
          Confirm
        </button>
        <button className="danger" disabled={done} onClick={() => act('cancel')} type="button">
          Cancel
        </button>
      </div>
    </div>
  )
}

function StateCard({ state }: { state: unknown }) {
  const cart = (state as { order?: unknown })?.order ?? state
  const c = cart as { items?: Array<{ qty: number; name?: string; id?: string; lineTotal?: number }>; total?: number; orderId?: string }
  if (c && Array.isArray(c.items)) {
    return (
      <div className="card">
        <h4>{c.orderId ? `Order ${c.orderId}` : 'Cart'}</h4>
        <table>
          <tbody>
            {c.items.map((i, idx) => (
              <tr key={idx}>
                <td>
                  {i.qty}× {i.name ?? i.id}
                </td>
                <td>₹{i.lineTotal ?? ''}</td>
              </tr>
            ))}
            {c.total != null ? (
              <tr className="total">
                <td>Total</td>
                <td>₹{c.total}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <div className="card">
      <h4>State</h4>
      <pre>{JSON.stringify(state, null, 2)}</pre>
    </div>
  )
}
