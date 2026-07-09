/**
 * UC recon phase 3 (H1): replay the discoverySearch endpoint with real queries
 * (our search_catalog), from inside the page context (real Chrome TLS + cookies,
 * same cross-origin path the site uses urbancompany.com → urbanclap.com/api).
 * Dump full responses so we can read service names, prices, and the tap-through
 * (categoryKey / href) to the service+slot page.
 *
 * Run: npx tsx scripts/uc-probe3.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

const OUT = 'scratchpad/uc'
const QUERIES = ['deep cleaning', 'instant maid', 'bathroom cleaning']

async function main() {
  mkdirSync(OUT, { recursive: true })
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: true })
  const page = await ctx.newPage()
  await page.goto('https://www.urbancompany.com/bangalore', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3500)

  for (const q of QUERIES) {
    const result = await page.evaluate(async (query) => {
      const res = await fetch('https://www.urbanclap.com/api/v2/growth/search/discoverySearch', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          city_key: null,
          location: { longitude: 77.603264, latitude: 12.961947 },
          cityKey: 'city_bangalore_v2',
          searchToken: query,
          source: 'homescreen',
          sourceMetadata: { pageName: 'homescreen' },
          recentSearches: [],
        }),
      })
      const text = await res.text()
      return { status: res.status, text }
    }, q)

    const slug = q.replace(/\s+/g, '-')
    writeFileSync(`${OUT}/search-${slug}.json`, result.text)
    console.log(`\n===== "${q}" → HTTP ${result.status}, ${result.text.length} bytes =====`)
    try {
      const j = JSON.parse(result.text)
      const store = j?.success?.data?.dataStore ?? {}
      // Walk the searchResultsCard items for service-like nodes.
      const results = store.searchResultsCard?.items ?? []
      console.log(`  searchResultsCard items: ${results.length}`)
      // Pull any text + tapAction categoryKey/href we can find in the whole payload.
      const texts = new Set<string>()
      const keys = new Set<string>()
      const walk = (o: unknown) => {
        if (!o || typeof o !== 'object') return
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          if (k === 'text' && typeof v === 'string' && v.length < 60) texts.add(v)
          if (k === 'categoryKey' && typeof v === 'string') keys.add(v)
          if (k === 'href' && typeof v === 'string') keys.add(v)
          walk(v)
        }
      }
      walk(store.searchResultsCard)
      walk(store.trendingSearchesCard)
      console.log(`  result texts: ${[...texts].slice(0, 12).join(' | ')}`)
      console.log(`  categoryKeys/hrefs: ${[...keys].slice(0, 8).join(' | ')}`)
    } catch {
      console.log(`  (non-JSON) head: ${result.text.slice(0, 200)}`)
    }
  }

  await browser.close()
  console.log(`\n(full dumps in ${OUT}/search-*.json)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
