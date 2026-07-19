'use client'

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'

type Item =
  | { kind: 'bubble'; who: 'agent' | 'user'; text: string }
  | { kind: 'action'; label: string }
  | { kind: 'state'; state: unknown }
  // The live-ride card: ONE card that updates in place as tracking polls arrive
  // (not a new card per poll).
  | { kind: 'tracking'; state: unknown }
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
  // A custom delivery address typed by the user — overrides GPS when set.
  const [addrInput, setAddrInput] = useState('')
  const [customAddr, setCustomAddr] = useState<string | null>(null)
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

  // Set a custom delivery address (overrides GPS). Mid-session it re-pins via the
  // /location endpoint; before a session exists it's applied on the next request.
  const applyAddress = useCallback(async (a: string) => {
    const addr = a.trim()
    if (!addr) return
    setCustomAddr(addr)
    setDeliveryLabel(addr)
    setAddrInput('')
    const id = sessionId.current
    if (id) {
      await fetch(`/api/sessions/${id}/location`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      })
    }
  }, [])

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
          const s = ev.state as { deliverTo?: { address?: string; city?: string }; tracking?: unknown }
          const addr = s?.deliverTo
          if (addr?.address ?? addr?.city) setDeliveryLabel((addr.address ?? addr.city) ?? null)
          if (s?.tracking) {
            // Upsert the single live-ride card: replace it in place if present,
            // else append once — so polling updates one card instead of piling up.
            setItems((prev) => {
              const item: Item = { kind: 'tracking', state: ev.state }
              const idx = prev.findIndex((it) => it.kind === 'tracking')
              if (idx < 0) return [...prev, item]
              const next = [...prev]
              next[idx] = item
              return next
            })
          } else {
            push({ kind: 'state', state: ev.state })
          }
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
        body: JSON.stringify({
          text,
          // A typed custom address wins over GPS.
          ...(customAddr ? { deliveryAddress: customAddr } : location ? { location } : {}),
          ...(userId.current ? { userId: userId.current } : {}),
        }),
      })
      const { sessionId: id } = (await res.json()) as { sessionId: string }
      sessionId.current = id
      const es = new EventSource(`/api/sessions/${id}/stream`)
      for (const t of EVENT_TYPES) {
        es.addEventListener(t, (m) => {
          // EventSource fires a *native* 'error' event (no .data) on any
          // connection drop/reconnect — it shares the name of our app-level
          // 'error' event but carries no payload. Skip dataless events so we
          // don't JSON.parse(undefined); the listener below handles the
          // connection itself.
          const data = (m as MessageEvent).data
          if (typeof data === 'string' && data) handle(JSON.parse(data))
        })
      }
      es.addEventListener('error', () => es.close())
    },
    [handle, location, customAddr],
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
              {locStatus === 'denied' ? ' — denied; enter a delivery address below' : ' (or enter a delivery address below)'}
            </span>
          )}
          {/* Custom delivery address — overrides GPS. Resolved by the target
              adapter (Blinkit place-search / UC geocode). */}
          <form
            className="addrform"
            onSubmit={(e) => {
              e.preventDefault()
              void applyAddress(addrInput)
            }}
          >
            <input type="text" value={addrInput} onChange={(e) => setAddrInput(e.target.value)} placeholder="deliver to a different address…" autoComplete="off" aria-label="delivery address" />
            <button type="submit" className="link">
              Set address
            </button>
            {customAddr ? (
              <button
                type="button"
                className="link"
                onClick={() => {
                  setCustomAddr(null)
                  setDeliveryLabel(null)
                }}
              >
                use GPS
              </button>
            ) : null}
          </form>
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
    case 'tracking':
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
    // home-services booking shape
    service?: string
    category?: string
    price?: string
    earliestSlot?: string
    city?: string
    status?: string
    loggedInAs?: string
    packageBooked?: string
    selectedSlot?: string
    amountToPay?: string
    selectedAddress?: string
    note?: string
  }
  const isReadyToPay = c.status === 'ready-to-pay'
  const isUnavailable = c.status === 'unavailable'
  const isNeedsLogin = c.status === 'needs-login'
  // Home-services card (service + slot, not a cart of items). No deep-link
  // handoff anymore (§14.7) — the ready-to-pay window on this machine is the
  // handoff; unavailable/needs-login render as a plain message.
  if (c && c.service && (c.earliestSlot || isReadyToPay || isUnavailable || isNeedsLogin)) {
    if (isUnavailable || isNeedsLogin) {
      return (
        <div className="card">
          <h4>{isNeedsLogin ? 'Sign in to book' : 'Not available'}</h4>
          <div className="deliverto">🧹 {c.packageBooked ?? c.service}</div>
          {c.note ? <div>{c.note}</div> : null}
        </div>
      )
    }
    return (
      <div className="card">
        <h4>{isReadyToPay ? 'Booked — ready to pay' : 'Selected'}</h4>
        <div className="deliverto">🧹 {c.packageBooked ?? c.service}</div>
        {c.category ? <div>{c.category}</div> : null}
        {c.loggedInAs ? <div>Signed in as {c.loggedInAs}</div> : null}
        <table>
          <tbody>
            {c.price ? (
              <tr>
                <td>Price</td>
                <td>{c.price}</td>
              </tr>
            ) : null}
            {c.selectedSlot ? (
              <tr>
                <td>Slot</td>
                <td>{c.selectedSlot}</td>
              </tr>
            ) : c.earliestSlot ? (
              <tr>
                <td>Earliest slot</td>
                <td>{c.earliestSlot}</td>
              </tr>
            ) : null}
            {c.selectedAddress ? (
              <tr>
                <td>Address</td>
                <td>{c.selectedAddress}</td>
              </tr>
            ) : null}
            {c.amountToPay ? (
              <tr className="total">
                <td>Amount to pay</td>
                <td>{c.amountToPay}</td>
              </tr>
            ) : null}
            {c.city ? (
              <tr>
                <td>City</td>
                <td>{c.city}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {isReadyToPay ? (
          <div className="deliverto">A real, logged-in browser window is open on this machine — click "Proceed to pay" there.</div>
        ) : null}
      </div>
    )
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
  const tr = (state as { tracking?: TrackingState })?.tracking
  if (tr) {
    return (
      <div className="card">
        <h4>🚗 Live ride</h4>
        <div className="deliverto">
          {tr.status ?? 'Tracking'}
          {tr.etaText ? ` · ${tr.etaText}` : ''}
        </div>
        <table>
          <tbody>
            {tr.driver ? (
              <tr>
                <td>Driver</td>
                <td>
                  {tr.driver}
                  {tr.rating ? ` ★${tr.rating}` : ''}
                </td>
              </tr>
            ) : null}
            {tr.vehicle ? (
              <tr>
                <td>Vehicle</td>
                <td>
                  {tr.vehicle}
                  {tr.plate ? ` · ${tr.plate}` : ''}
                </td>
              </tr>
            ) : null}
            {tr.driverLat != null && tr.driverLng != null ? (
              <tr>
                <td>Driver at</td>
                <td>
                  {tr.driverLat.toFixed(5)}, {tr.driverLng.toFixed(5)}
                  {tr.distanceToPickupM != null ? ` · ~${tr.distanceToPickupM} m away` : ''}
                </td>
              </tr>
            ) : null}
            {tr.pin ? (
              <tr>
                <td>PIN</td>
                <td>{tr.pin}</td>
              </tr>
            ) : null}
            {tr.fare ? (
              <tr>
                <td>Fare</td>
                <td>{tr.fare}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {tr.driverLat != null && tr.driverLng != null ? (
          <a className="checkout" href={`https://www.google.com/maps?q=${tr.driverLat},${tr.driverLng}`} target="_blank" rel="noreferrer">
            📍 Driver on map →
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

type TrackingState = {
  status?: string
  driver?: string
  rating?: number
  vehicle?: string
  plate?: string
  etaText?: string
  driverLat?: number
  driverLng?: number
  distanceToPickupM?: number
  pin?: string
  fare?: string
}
