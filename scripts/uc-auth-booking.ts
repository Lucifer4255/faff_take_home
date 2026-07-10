/**
 * Build up the authenticated booking flow (Tier B), verifying each step headless
 * with the captured Bearer token. Imports the CDP-captured session, then drives
 * the booking under the user's account. STOPS before payment.
 *
 * Run: npx tsx scripts/uc-auth-booking.ts
 */
import { readFileSync } from 'node:fs'
import { closeClient, setCoords } from '../src/adapters/homeservices/client'
import { addPackage, getCart, importFromSession, startBooking } from '../src/adapters/homeservices/auth'

const USER = 'cdp-user'

// biome-ignore lint: test payload from a captured request
function capturedPackages(): any[] {
  const m = JSON.parse(readFileSync('scratchpad/uc/booking/_manifest.json', 'utf8'))
  const i = m.find((c: { url: string }) => /updatePackageSelection/.test(c.url)).i
  const req = JSON.parse(readFileSync(`scratchpad/uc/booking/${String(i).padStart(2, '0')}-req.json`, 'utf8'))
  return req.packages
}

async function main() {
  const auth = importFromSession(USER)
  if (!auth) {
    console.log('✗ no session to import — run the CDP capture first (.data/uc-session.json)')
    process.exit(1)
  }
  console.log(`✓ imported UC auth for ${auth.name ?? auth.ucUserId} (token len ${auth.token.length})`)

  setCoords(12.9719, 77.5937) // Bangalore (browsing city)
  console.log('\n[1] startBooking (initiateJourney) …')
  const draft = await startBooking({
    categoryKey: 'professional_home_cleaning',
    cityKey: 'city_bangalore_v2',
    lat: 12.9719,
    lon: 77.5937,
    ucUserId: auth.ucUserId ?? '',
    token: auth.token,
  })
  console.log(`    ✓ draft order minted UNDER THE USER'S ACCOUNT: draftOrderId=${draft.draftOrderId}`)

  console.log('\n[2] addPackage (updatePackageSelection) — cart write under the account …')
  const pkgs = capturedPackages()
  const added = await addPackage(draft.draftOrderId, pkgs, auth.token)
  console.log(`    ${added.ok ? '✓' : '✗'} updatePackageSelection HTTP ${added.status} (added: ${pkgs.map((p: { name?: string }) => p.name).join(', ')})`)

  console.log('\n[3] getCart (getPackagesDataInPersistentCart) …')
  const cart = await getCart(draft.draftOrderId, draft.cityKey, auth.token)
  console.log(`    cart items: ${cart.itemNames.join(' | ') || '(none)'}`)
  console.log(`    cart total: ${cart.total != null ? `₹${cart.total}` : '(not parsed)'}`)
  console.log(added.ok && cart.itemNames.length ? '\n✅ CART BUILT UNDER THE USER ACCOUNT, HEADLESS (stopped before payment).' : '\n⚠ cart not confirmed — inspect')

  await closeClient()
}

main().catch(async (e) => {
  console.error('\nFAILED:', e)
  await closeClient().catch(() => {})
  process.exit(1)
})
