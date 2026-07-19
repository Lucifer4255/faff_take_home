/** Controlled run: dispatch cheapest, capture driver/location + cancel UI, attempt cancel. Human backstops. */
import { book, closeClient, diagnoseActiveTrip, quote, resolve } from '../src/adapters/delivery/client'

async function main() {
  const u = 'default'
  const p = await resolve(u, 'Park Street', 'PICKUP')
  const d = await resolve(u, 'Quest Mall', 'DROPOFF')
  if (!p || !d) throw new Error('resolve failed')
  const q = await quote(u, p, d)
  const chosen = [...q.products].filter((o) => Number.isFinite(o.fareValue)).sort((a, b) => a.fareValue - b.fareValue)[0]
  console.log(`BOOKING ${chosen.displayName} ${chosen.fare} (vvid ${chosen.vvid}) — REAL dispatch`)
  const r = await book(u, p, d, chosen.vvid ?? '')
  console.log('BOOK:', JSON.stringify({ dispatched: r.dispatched, tripId: r.tripId, note: r.note }))
  if (!r.dispatched) {
    await closeClient(u)
    return
  }
  console.log('--- capturing live trip (driver/location + cancel UI) ---')
  const diag = await diagnoseActiveTrip(u, 10_000)
  console.log('CONTROLS:', JSON.stringify(diag.controls))
  console.log('CANCEL CLICKED:', diag.cancelClicked, '| cancelOps:', JSON.stringify(diag.cancelOps))
  console.log('STATUS BODIES:', diag.statusBodies.length)
  // Print the richest (last) status body to reveal driver/vehicle/location fields.
  if (diag.statusBodies.length) console.log('LAST STATUS:', diag.statusBodies[diag.statusBodies.length - 1])
  await closeClient(u)
  console.log('DONE — CANCEL IN THE APP NOW IF STILL ACTIVE')
}
main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
