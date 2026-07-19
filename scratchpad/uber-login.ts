/**
 * Tier-B activation: open the adapter's own browser profile (headful) at Uber's
 * login, wait for the HUMAN to sign in, then prove live fares work through the
 * client. Run with UBER_HEADFUL=1 so every call stays in the one visible window
 * (otherwise isLoggedIn/quote would relaunch headless and close the login tab).
 */
import { closeClient, isLoggedIn, quote, resolve, startLogin } from '../src/adapters/delivery/client'

async function main() {
  const u = 'default'
  await startLogin(u) // opens a real Chrome window at auth.uber.com
  console.log('>>> LOGIN WINDOW IS OPEN — sign in with Google/Apple/OTP. I will not touch it.')
  console.log('>>> Polling for your session (up to 5 min)...')

  let ok = false
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    ok = await isLoggedIn(u).catch(() => false)
    if (ok) break
    if (i % 3 === 0) console.log(`    ...waiting (${i * 5}s elapsed)`)
  }
  if (!ok) {
    console.log('!!! TIMEOUT — not signed in. Re-run when ready.')
    await closeClient(u)
    process.exit(1)
  }
  console.log('LOGGED IN ✓  — pulling a live Tier-B quote (Park Street -> Quest Mall)...')

  const p = await resolve(u, 'Park Street', 'PICKUP')
  const d = await resolve(u, 'Quest Mall', 'DROPOFF')
  if (!p || !d) {
    console.log('resolve failed', { p: !!p, d: !!d })
    await closeClient(u)
    process.exit(1)
  }
  const q = await quote(u, p, d)
  console.log(`TIER B quote  loggedIn=${q.loggedIn}  options=${q.products.length}`)
  for (const o of q.products) console.log(`   ${o.displayName.padEnd(14)} ${o.fare.padEnd(10)} eta ${o.etaInMin ?? '?'}m  seats ${o.capacity ?? '?'}  vvid ${o.vvid ?? '?'}`)

  console.log('DONE — session persisted in the profile (gitignored). You can close the window.')
  await closeClient(u)
}

main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
