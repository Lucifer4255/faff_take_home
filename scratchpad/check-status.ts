import { closeClient, isLoggedIn, track } from '../src/adapters/delivery/client'
async function main() {
  const u = 'default'
  console.log('logged in:', await isLoggedIn(u))
  const snaps = await track(u, { durationMs: 8000, intervalMs: 2500, onSnapshot: (s) => console.log(`status=${s.status ?? '?'} nearby=${s.nearbyVehicles ?? '?'} driver=${s.driver ?? '-'}`) })
  console.log('snapshots:', snaps.length)
  if (snaps.length) console.log('rawSlice:', snaps[snaps.length - 1].rawSlice)
  await closeClient(u)
  console.log('DONE')
}
main().catch((e) => { console.error('ERR', e); process.exit(1) })
