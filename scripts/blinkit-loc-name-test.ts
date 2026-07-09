/**
 * Final discriminator: compare Bangalore vs Gurugram search results by product
 * NAME (not product_id, which is variant/listing-level and inflates difference).
 * If the same brands/products appear in both cities → "location-agnostic" holds
 * at the assortment level. If the names differ (regional brands) → it's filtered.
 *
 * Run: MOCK_ADAPTERS=0 npx tsx scripts/blinkit-loc-name-test.ts
 */
import { extractProducts } from '../src/adapters/blinkit/parse'
import { closeClient, searchRaw, setLocation } from '../src/adapters/blinkit/client'

const QUERIES = ['milk', 'eggs']
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

async function names(q: string): Promise<Set<string>> {
  return new Set(extractProducts(await searchRaw(q)).map((p) => norm(p.name)))
}

async function main() {
  const out: Record<string, { blr: Set<string>; ggn: Set<string> }> = {}
  await setLocation(12.9352, 77.6245, false) // Bangalore
  for (const q of QUERIES) out[q] = { blr: await names(q), ggn: new Set() }
  await setLocation(28.4229, 77.0447, false) // Gurugram
  for (const q of QUERIES) out[q].ggn = await names(q)

  for (const q of QUERIES) {
    const { blr, ggn } = out[q]
    const shared = [...blr].filter((n) => ggn.has(n))
    const uni = new Set([...blr, ...ggn]).size
    console.log(`\n===== "${q}" by NAME =====`)
    console.log(`  BLR=${blr.size} GGN=${ggn.size} shared=${shared.length} (Jaccard ${((shared.length / uni) * 100).toFixed(0)}%)`)
    console.log(`  shared: ${shared.join(' | ') || '(none)'}`)
    console.log(`  BLR-only: ${[...blr].filter((n) => !ggn.has(n)).join(' | ')}`)
    console.log(`  GGN-only: ${[...ggn].filter((n) => !blr.has(n)).join(' | ')}`)
  }
  await closeClient()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
