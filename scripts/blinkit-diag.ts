import './preload'
import { writeFileSync } from 'node:fs'
import { closeClient, currentIdentity, getLocation, searchRaw } from '../src/adapters/blinkit/client'
import { extractProducts } from '../src/adapters/blinkit/parse'

const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'

// Look for a "not serviceable" signal inside a layout response.
function serviceabilitySignal(raw: unknown): string {
  const s = JSON.stringify(raw)
  const m = s.match(/not[_ ]?serviceable|unserviceable|not available in your area|no products|out of the delivery/i)
  return m ? m[0] : ''
}

async function main() {
  console.log('IDENTITY:', await currentIdentity())
  console.log('LOCATION:', JSON.stringify(await getLocation()))
  const queries = ['dozen eggs', '500ml curd', 'eggs', 'curd', 'milk', 'eggs', 'curd']
  for (const q of queries) {
    try {
      const raw = await searchRaw(q)
      const products = extractProducts(raw)
      const sig = serviceabilitySignal(raw)
      const loc = await getLocation()
      console.log(
        `"${q}" → ${products.length} products | serviceable=${loc.serviceable} | id=${await currentIdentity()}${sig ? ` | ⚠ signal="${sig}"` : ''}`,
      )
      if (products.length === 0) {
        const f = `${OUT}/blinkit-diag-${q.replace(/\s+/g, '_')}.json`
        writeFileSync(f, JSON.stringify(raw, null, 1).slice(0, 4000))
        console.log(`   (empty — dumped first 4KB to ${f})`)
      }
    } catch (e) {
      console.log(`"${q}" → THREW: ${e instanceof Error ? e.message : e}`)
    }
  }
}
main()
  .catch((e) => {
    console.error('DIAG FAIL', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeClient()
    process.exit(process.exitCode ?? 0)
  })
