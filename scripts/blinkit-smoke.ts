import './preload'
import { closeClient, getLocation, searchRaw } from '../src/adapters/blinkit/client'
import { extractProducts } from '../src/adapters/blinkit/parse'

async function main() {
  const loc = await getLocation()
  console.log('LOCATION:', JSON.stringify(loc))
  for (const q of ['milk', 'brown bread', 'eggs']) {
    const raw = await searchRaw(q)
    const products = extractProducts(raw)
    console.log(`\n"${q}" → ${products.length} products`)
    for (const p of products.slice(0, 6)) {
      console.log(`  - ${p.id} | ${p.name} | ₹${p.price} | ${p.unit ?? ''} | inStock=${p.inStock}`)
    }
  }
}
main()
  .catch((e) => {
    console.error('SMOKE FAIL', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeClient()
    process.exit(process.exitCode ?? 0)
  })
