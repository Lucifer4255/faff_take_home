/**
 * Control for the location-agnostic test: is search even DETERMINISTIC at a
 * fixed location? Search the same query TWICE at Bangalore (no location change
 * between), then once at Gurugram. Compare:
 *   - BLR#1 vs BLR#2  = same-location baseline (ranking/personalization noise)
 *   - BLR#1 vs GGN     = cross-city signal
 * If baseline overlap ≈ 100% and cross-city ≪ that, search is location-filtered.
 *
 * Run: MOCK_ADAPTERS=0 npx tsx scripts/blinkit-loc-control-test.ts
 */
import { extractProducts } from '../src/adapters/blinkit/parse'
import { closeClient, searchRaw, setLocation } from '../src/adapters/blinkit/client'

const Q = 'milk'

async function ids(): Promise<Set<string>> {
  return new Set(extractProducts(await searchRaw(Q)).map((p) => p.id))
}
function jac(a: Set<string>, b: Set<string>): string {
  const inter = [...a].filter((x) => b.has(x)).length
  const uni = new Set([...a, ...b]).size
  return uni ? `${((inter / uni) * 100).toFixed(0)}% (shared ${inter}/${uni})` : 'n/a'
}

async function main() {
  await setLocation(12.9352, 77.6245, false) // Bangalore / Koramangala
  const blr1 = await ids()
  const blr2 = await ids() // same location, no change
  await setLocation(28.4229, 77.0447, false) // Gurugram / Sector 50
  const ggn = await ids()

  console.log(`\n"${Q}" set sizes: BLR#1=${blr1.size} BLR#2=${blr2.size} GGN=${ggn.size}`)
  console.log(`  BLR#1 vs BLR#2 (same-loc baseline): ${jac(blr1, blr2)}`)
  console.log(`  BLR#1 vs GGN   (cross-city signal): ${jac(blr1, ggn)}`)
  await closeClient()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
