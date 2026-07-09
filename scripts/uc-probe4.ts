/**
 * UC recon phase 4 (H1): capture the site's OWN request headers on a working
 * api/v2 call (getDiscoveryScreen), then replay discoverySearch with the same
 * header set so it doesn't 500. Reveals what auth/device/tenant headers the
 * adapter's client must carry.
 *
 * Run: npx tsx scripts/uc-probe4.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Request } from 'playwright'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

const OUT = 'scratchpad/uc'

async function main() {
  mkdirSync(OUT, { recursive: true })
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: true })
  const page = await ctx.newPage()

  let captured: Record<string, string> | null = null
  ctx.on('request', (req: Request) => {
    const u = req.url()
    if (/urbanclap\.com\/api\/v2\/growth\//.test(u) && !/log|monitor|metric/i.test(u) && !captured) {
      captured = req.headers()
    }
  })

  await page.goto('https://www.urbancompany.com/bangalore', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)

  if (!captured) {
    console.log('no api/v2/growth request captured')
    await browser.close()
    return
  }
  console.log('===== captured request headers (site getDiscoveryScreen) =====')
  for (const [k, v] of Object.entries(captured)) console.log(`  ${k}: ${String(v).slice(0, 80)}`)
  writeFileSync(`${OUT}/_headers.json`, JSON.stringify(captured, null, 2))

  // Replay discoverySearch with the captured headers (drop hop-by-hop / auto ones).
  const drop = new Set(['host', 'content-length', 'accept-encoding', 'connection', ':authority', ':method', ':path', ':scheme'])
  const headers = Object.fromEntries(Object.entries(captured).filter(([k]) => !drop.has(k.toLowerCase())))

  for (const q of ['deep cleaning', 'instant maid']) {
    const r = await page.evaluate(
      async ({ query, headers }) => {
        const res = await fetch('https://www.urbanclap.com/api/v2/growth/search/discoverySearch', {
          method: 'POST',
          credentials: 'omit',
          headers,
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
        return { status: res.status, text: await res.text() }
      },
      { query: q, headers },
    )
    const slug = q.replace(/\s+/g, '-')
    writeFileSync(`${OUT}/search-${slug}.json`, r.text)
    console.log(`\n"${q}" → HTTP ${r.status}, ${r.text.length} bytes`)
    if (r.status !== 200) console.log(`  head: ${r.text.slice(0, 220)}`)
  }

  await browser.close()
  console.log(`\n(dumps in ${OUT}/search-*.json, headers in ${OUT}/_headers.json)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
