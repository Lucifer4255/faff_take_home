/**
 * REAL RIDE test (money line): book the cheapest option, poll live status, then
 * cancel — the once/last/cheap/cancel-first sequence from DESIGN §5. Dispatches a
 * REAL driver. Only run with explicit go-ahead; a human should be ready to cancel
 * in the Uber app as a backstop.
 *
 * Route + product overridable via env: PICKUP, DROP, VVID (else cheapest).
 */
import { book, cancel, closeClient, quote, resolve, track } from '../src/adapters/delivery/client'

async function main() {
  const u = 'default'
  const pickupText = process.env.PICKUP ?? 'Park Street'
  const dropText = process.env.DROP ?? 'Quest Mall'

  const p = await resolve(u, pickupText, 'PICKUP')
  const d = await resolve(u, dropText, 'DROPOFF')
  if (!p || !d) throw new Error('resolve failed')

  const q = await quote(u, p, d)
  if (!q.loggedIn) throw new Error('not logged in — activate Tier B first')
  const cheapest = [...q.products].filter((o) => Number.isFinite(o.fareValue)).sort((a, b) => a.fareValue - b.fareValue)[0]
  const chosen = process.env.VVID ? q.products.find((o) => o.vvid === process.env.VVID) ?? cheapest : cheapest
  console.log(`ROUTE ${p.title} -> ${d.title}`)
  console.log(`BOOKING: ${chosen.displayName} ${chosen.fare} (vvid ${chosen.vvid})  — dispatching a REAL driver now`)

  const r = await book(u, p, d, chosen.vvid ?? '')
  console.log('BOOK result:', r)

  console.log('--- tracking (wait for driver match, up to 28s) ---')
  await track(u, {
    durationMs: 28_000,
    intervalMs: 3000,
    onSnapshot: (s) =>
      console.log(
        `  [${s.status ?? '?'}] driver=${s.driver || '-'}${s.driverRating ? ` ★${s.driverRating}` : ''} veh=${s.vehicle || '-'} plate=${s.plate || '-'} eta=${s.etaText || '-'} loc=${s.driverLat ?? '?'},${s.driverLng ?? '?'} dist=${s.distanceToPickupM ?? '?'}m pin=${s.pin || '-'}`,
      ),
  })

  console.log('--- CANCELLING (fixed: Cancel ride -> YES, CANCEL, verified) ---')
  const c = await cancel(u)
  console.log('CANCEL result:', JSON.stringify(c))

  await closeClient(u)
  console.log('DONE')
}

main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
