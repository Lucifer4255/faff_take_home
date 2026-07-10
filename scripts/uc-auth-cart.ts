/**
 * Finish Tier B cart-build: replay the captured precursor (getEditablePackageDetailScreen)
 * THEN updatePackageSelection on the persistent draft with the token, so the
 * agent actually writes the cart UNDER the user's account. Then read it back.
 *
 * Run: npx tsx scripts/uc-auth-cart.ts
 */
import { readFileSync } from 'node:fs'
import { apiPost, closeClient, setCoords } from '../src/adapters/homeservices/client'
import { getCart, importFromSession } from '../src/adapters/homeservices/auth'

// biome-ignore lint: captured payloads
type Any = any
function capturedReq(urlRe: string): Any {
  const m = JSON.parse(readFileSync('scratchpad/uc/booking/_manifest.json', 'utf8'))
  const i = m.find((c: { url: string }) => new RegExp(urlRe).test(c.url)).i
  return JSON.parse(readFileSync(`scratchpad/uc/booking/${String(i).padStart(2, '0')}-req.json`, 'utf8'))
}

async function main() {
  const auth = importFromSession('cdp-user')
  if (!auth) throw new Error('no session')
  console.log(`✓ auth ${auth.name}`)
  setCoords(12.9719, 77.5937)

  const pkgDetail = capturedReq('getEditablePackageDetailScreen')
  const draftOrderId = capturedReq('updatePackageSelection').draftOrderId
  console.log(`\n[1] getEditablePackageDetailScreen (packageId ${pkgDetail.packageId}) — load editable state …`)
  const r1 = await apiPost('growth/customerJourney/getEditablePackageDetailScreen', pkgDetail, auth.token)
  console.log(`    HTTP ${r1.status}`)

  console.log('\n[2] updatePackageSelection — cart write under the account …')
  const upd = capturedReq('updatePackageSelection')
  const r2 = await apiPost('growth/customerJourney/updatePackageSelection', upd, auth.token)
  console.log(`    HTTP ${r2.status}`)

  console.log('\n[3] getCart (persistent cart, both cities) …')
  const blr = await getCart('city_bangalore_v2', 12.9719, 77.5937, auth.token)
  const kol = await getCart('city_kolkata_v2', 22.5726, 88.3639, auth.token)
  console.log(`    totalPackages → Bangalore=${blr.totalPackages}  Kolkata=${kol.totalPackages}`)
  const inCart = Math.max(blr.totalPackages, kol.totalPackages)
  console.log(r2.status === 200 && inCart > 0 ? `\n✅ AGENT BUILT THE CART UNDER THE ACCOUNT, HEADLESS (${inCart} package in cart).` : `\n⚠ write ok (${r2.status}) but cart reads empty — draftOrderId=${draftOrderId}`)

  await closeClient()
}

main().catch(async (e) => {
  console.error(e)
  await closeClient().catch(() => {})
  process.exit(1)
})
