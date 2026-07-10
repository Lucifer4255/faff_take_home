/**
 * Diagnostic: reproduce the REAL production path — searchServices → extractServices
 * (same as search_catalog) → buildAuthenticatedBooking with the actual searched
 * name/price (same as confirm()) — to confirm the fix holds for how the harness
 * actually calls it, not just a hand-picked package.
 *
 * Run: npx tsx scratchpad/diag-uc-full-flow.ts
 */
import { readFileSync } from 'node:fs'
import { buildAuthenticatedBooking } from '../src/adapters/homeservices/booking'
import { closeClient, searchServices, setCoords } from '../src/adapters/homeservices/client'
import { extractServices } from '../src/adapters/homeservices/parse'

async function main() {
  const store = JSON.parse(readFileSync('.data/uc-auth.json', 'utf8'))
  const [, auth] = Object.entries(store)[0] as [string, { token: string; ucUserId?: string; name?: string }]

  const { label } = setCoords(12.9719, 77.5937)
  console.log(`[1] search_catalog "deep cleaning" (city=${label}) …`)
  const services = extractServices(await searchServices('deep cleaning'))
  console.log(`    ${services.length} results, top: ${services.slice(0, 3).map((s) => `${s.name} (₹${s.price})`).join(' | ')}`)
  if (services.length === 0) throw new Error('no search results')
  const chosen = services[0]

  console.log(`\n[2] buildAuthenticatedBooking for "${chosen.name}" (₹${chosen.price}) …`)
  const result = await buildAuthenticatedBooking({
    categoryKey: chosen.categoryKey,
    cityKey: 'city_bangalore_v2',
    lat: 12.9719,
    lon: 77.5937,
    ucUserId: auth.ucUserId ?? '',
    token: auth.token,
    wantName: chosen.name,
    wantPrice: chosen.price,
    houseNumber: '1',
    recipientName: auth.name ?? 'Customer',
  })
  console.log('\n✅ SUCCESS (real search_catalog → confirm path)')
  console.log(JSON.stringify({ ...result, raw: '(omitted)' }, null, 2))
}

main()
  .catch((e) => console.error('\n✗ FAILED:', e instanceof Error ? e.message : e))
  .finally(async () => {
    await closeClient().catch(() => {})
  })
