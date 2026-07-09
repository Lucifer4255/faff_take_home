/**
 * CTO claim re-test: is Blinkit search location-AGNOSTIC?
 *
 * Hypothesis to settle: search *content* (which products match a query) is a
 * national catalog and does NOT change with location; only inventory (inStock)
 * and price are per-dark-store. And: is *any* location even required to get hits?
 *
 * Method: same query at two far-apart serviceable locations (Bangalore vs
 * Gurugram) → compare the product-id sets. Then a mid-ocean garbage location →
 * does search still return products, 400, or empty?
 *
 * Run: MOCK_ADAPTERS=0 npx tsx scripts/blinkit-loc-agnostic-test.ts
 */
import { extractProducts } from '../src/adapters/blinkit/parse'
import { closeClient, searchRaw, setLocation } from '../src/adapters/blinkit/client'

const QUERIES = ['milk', 'brown bread', 'eggs']
const LOCATIONS = [
  { name: 'Bangalore / Koramangala', lat: 12.9352, lon: 77.6245 },
  { name: 'Gurugram / Sector 50', lat: 28.4229, lon: 77.0447 },
  { name: 'Mid-Arabian-Sea (unserviceable)', lat: 15.0, lon: 65.0 },
]

function fmt(p: { id: string; name: string; price: number; inStock: boolean }) {
  return `${p.id}  ₹${p.price}  ${p.inStock ? 'in' : 'OUT'}  ${p.name}`
}

async function main() {
  // location -> query -> products
  const results: Record<string, Record<string, ReturnType<typeof extractProducts>>> = {}

  for (const loc of LOCATIONS) {
    console.log(`\n===== SET LOCATION: ${loc.name} (${loc.lat},${loc.lon}) =====`)
    try {
      const pinned = await setLocation(loc.lat, loc.lon, false)
      console.log(`  resolved: ${pinned.address ?? '(no address)'}  serviceable=${pinned.serviceable}`)
    } catch (e) {
      console.log(`  setLocation failed: ${(e as Error).message}`)
    }
    results[loc.name] = {}
    for (const q of QUERIES) {
      try {
        const products = extractProducts(await searchRaw(q))
        results[loc.name][q] = products
        console.log(`\n  "${q}" → ${products.length} products`)
        for (const p of products.slice(0, 8)) console.log(`     ${fmt(p)}`)
      } catch (e) {
        results[loc.name][q] = []
        console.log(`\n  "${q}" → ERROR: ${(e as Error).message}`)
      }
    }
  }

  // Compare the two serviceable locations product-id sets per query.
  console.log('\n\n===== VERDICT: content overlap between Bangalore and Gurugram =====')
  const [a, b] = [LOCATIONS[0].name, LOCATIONS[1].name]
  for (const q of QUERIES) {
    const ida = new Set((results[a]?.[q] ?? []).map((p) => p.id))
    const idb = new Set((results[b]?.[q] ?? []).map((p) => p.id))
    const inter = [...ida].filter((id) => idb.has(id))
    const union = new Set([...ida, ...idb])
    const jaccard = union.size ? ((inter.length / union.size) * 100).toFixed(0) : 'n/a'
    // price divergence on the shared products (should differ if price is per-store)
    const priceDiffs = [...ida]
      .filter((id) => idb.has(id))
      .map((id) => {
        const pa = results[a][q].find((p) => p.id === id)!
        const pb = results[b][q].find((p) => p.id === id)!
        return pa.price !== pb.price ? `${id}: ₹${pa.price} vs ₹${pb.price}` : null
      })
      .filter(Boolean)
    console.log(
      `\n  "${q}": BLR=${ida.size} GGN=${idb.size} shared=${inter.length} (Jaccard ${jaccard}%)`,
    )
    console.log(`     price differs on shared ids: ${priceDiffs.length ? priceDiffs.join('; ') : 'none'}`)
  }

  await closeClient()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
