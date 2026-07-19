/** Verify Tier B against the persisted 'default' login (headless — no window). */
import { closeClient, isLoggedIn, quote, resolve } from '../src/adapters/delivery/client'

async function main() {
  const u = 'default'
  console.log('logged in:', await isLoggedIn(u))
  const p = await resolve(u, 'Park Street', 'PICKUP')
  const d = await resolve(u, 'Quest Mall', 'DROPOFF')
  if (!p || !d) {
    console.log('resolve failed', { p: !!p, d: !!d })
    await closeClient(u)
    process.exit(1)
  }
  const q = await quote(u, p, d)
  console.log(`TIER B  loggedIn=${q.loggedIn}  options=${q.products.length}`)
  for (const o of q.products) console.log(`   ${o.displayName.padEnd(14)} ${o.fare.padEnd(9)} eta ${o.etaInMin ?? '?'}m  seats ${o.capacity ?? '?'}  vvid ${o.vvid ?? '?'}`)
  await closeClient(u)
  console.log('OK')
}
main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
