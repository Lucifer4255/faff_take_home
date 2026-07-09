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

type Geo = { lat: number; lon: number }

export default function Chat() {
  const [items, setItems] = useState<Item[]>([])
  const [awaiting, setAwaiting] = useState(false)
  const [busy, setBusy] = useState(false) // a turn is actively streaming
  const [finished, setFinished] = useState(false)
  const [input, setInput] = useState('')
  const [location, setLocation] = useState<Geo | null>(null)
  const [locStatus, setLocStatus] = useState<'idle' | 'locating' | 'set' | 'denied'>('idle')
  // The delivery address the backend actually resolved (store), shown in the bar.
  const [deliveryLabel, setDeliveryLabel] = useState<string | null>(null)
  const sessionId = useRef<string | null>(null)
  const userId = useRef<string>('')
  const logRef = useRef<HTMLDivElement>(null)

  // Stable per-browser user id → keys this user's Blinkit login + conversation
  // memory, so different people using the app never share a cart/account.
  useEffect(() => {
    try {
      let id = localStorage.getItem('faff_user_id')
      if (!id) {
        id = crypto.randomUUID()
        localStorage.setItem('faff_user_id', id)
      }
      userId.current = id
    } catch {
      userId.current = `web-${Math.random().toString(36).slice(2)}`
    }
  }, [])

  // Ask the real browser (this device) for its GPS location, then persist it.
  const requestLocation = useCallback(() => {
    if (!('geolocation' in navigator)) return setLocStatus('denied')
    setLocStatus('locating')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const geo = { lat: pos.coords.latitude, lon: pos.coords.longitude }
        setLocation(geo)
        setLocStatus('set')
        try {
          localStorage.setItem('blinkit_location', JSON.stringify(geo))
        } catch {
          /* ignore */
        }
      },
      () => setLocStatus('denied'),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }, [])

  // On first load: reuse a previously granted location, else auto-prompt for it.
  // If the user denies, the agent falls back to asking for a delivery address.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('blinkit_location')
      if (saved) {
        setLocation(JSON.parse(saved) as Geo)
        setLocStatus('set')
        return
      }
    } catch {
      /* ignore */
    }
    requestLocation()
  }, [requestLocation])

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
      setBusy(true)
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
        case 'state_update': {
          const addr = (ev.state as { deliverTo?: { address?: string; city?: string } })?.deliverTo
          if (addr?.address ?? addr?.city) setDeliveryLabel((addr.address ?? addr.city) ?? null)
          push({ kind: 'state', state: ev.state })
          break
        }
        case 'question':
          setAwaiting(true)
          setBusy(false)
          push({ kind: 'question', text: String(ev.text), options: ev.options as string[] | undefined })
          break
        case 'awaiting_confirmation':
          setAwaiting(true)
          setBusy(false)
          push({
            kind: 'gate',
            summary: String(ev.summary),
            amount: ev.amount as number | undefined,
            currency: (ev.currency as string) ?? 'INR',
          })
          break
        case 'done':
          // A turn finished — the session stays open for follow-ups (multi-turn).
          setBusy(false)
          break
        case 'error':
          setFinished(true)
          setBusy(false)
          push({ kind: 'status', variant: 'error', text: String(ev.message) })
          break
      }
    },
    [push],
  )

  const start = useCallback(
    async (text: string) => {
      setBusy(true)
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, ...(location ? { location } : {}), ...(userId.current ? { userId: userId.current } : {}) }),
      })
      const { sessionId: id } = (await res.json()) as { sessionId: string }
      sessionId.current = id
      const es = new EventSource(`/api/sessions/${id}/stream`)
      for (const t of EVENT_TYPES) {
        es.addEventListener(t, (m) => handle(JSON.parse((m as MessageEvent).data)))
      }
      es.addEventListener('error', () => es.close())
    },
    [handle, location],
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
        <div className="locbar">
          {deliveryLabel ? (
            <span className="loc set">
              📍 Delivering to {deliveryLabel} ·{' '}
              <button type="button" className="link" onClick={requestLocation}>
                use my location
              </button>
            </span>
          ) : locStatus === 'set' && location ? (
            <span className="loc set">
              📍 Delivering to your location ({location.lat.toFixed(3)}, {location.lon.toFixed(3)}) ·{' '}
              <button type="button" className="link" onClick={requestLocation}>
                update
              </button>
            </span>
          ) : locStatus === 'locating' ? (
            <span className="loc">📍 getting your location…</span>
          ) : (
            <span className="loc">
              <button type="button" className="link" onClick={requestLocation}>
                📍 Use my current location
              </button>
              {locStatus === 'denied' ? ' — denied; just tell the agent your delivery area in chat' : ' (or tell the agent your delivery area)'}
            </span>
          )}
        </div>
        <form onSubmit={onSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={finished || busy}
            placeholder={
              finished
                ? 'session ended — reload to start again'
                : busy
                  ? 'working…'
                  : awaiting
                    ? 'type your reply…'
                    : items.length
                      ? 'ask a follow-up, or order something…'
                      : 'e.g. "what are the cheapest milk options?" or "get me 2L milk"'
            }
            autoComplete="off"
          />
          <button className="primary" type="submit" disabled={finished || busy}>
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
  const c = cart as {
    items?: Array<{ qty: number; name?: string; id?: string; lineTotal?: number }>
    total?: number
    orderId?: string
    checkoutUrl?: string
    deliverTo?: { address?: string; city?: string }
  }
  if (c && Array.isArray(c.items)) {
    return (
      <div className="card">
        <h4>{c.orderId ? `Order ${c.orderId}` : 'Cart'}</h4>
        {c.deliverTo?.address ? <div className="deliverto">📍 {c.deliverTo.address}</div> : null}
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
        {c.checkoutUrl ? (
          <a className="checkout" href={c.checkoutUrl} target="_blank" rel="noreferrer">
            🛒 Open cart on Blinkit →
          </a>
        ) : null}
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
