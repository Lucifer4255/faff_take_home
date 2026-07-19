import { loadDotEnv } from '@/core/env'
import { searchServices, closeClient } from '@/adapters/homeservices/client'
import { extractServices } from '@/adapters/homeservices/parse'

// Probe the real categoryKey/name for a few search terms so the MCP POC can be
// pointed at the right category URL. Guest search — no auth.
loadDotEnv()

async function main() {
  for (const q of ['ac service', 'ac cleaning', 'spa for women', 'massage', 'salon']) {
    try {
      const services = extractServices(await searchServices(q))
      console.log(`\n### "${q}" → ${services.length} results`)
      for (const s of services.slice(0, 6)) {
        console.log(`  ${s.categoryKey.padEnd(34)} | ₹${String(s.price).padEnd(6)} | ${s.name}`)
      }
    } catch (e) {
      console.log(`\n### "${q}" → ERROR ${e instanceof Error ? e.message : e}`)
    }
  }
  await closeClient()
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
