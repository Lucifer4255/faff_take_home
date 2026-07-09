/**
 * B1 live capture (DESIGN.md §12.1). Drives a REAL Chromium via Playwright to
 * satisfy Cloudflare's TLS/JA3 fingerprint (plain curl → 403, see the B1
 * findings), sets a delivery location, then issues Blinkit's own JSON API calls
 * from inside the page via `fetch` and dumps the raw shapes so the parser
 * (src/adapters/blinkit/parse.ts) is written against reality, not assumption.
 *
 * Run: npx tsx scripts/blinkit-probe.ts "milk"
 * Output: scratchpad/blinkit-*.json  (raw request headers + search/cart JSON)
 *
 * Location: Koramangala, Bangalore (a definitely-serviceable dark-store area).
 */
import './preload'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'
const LAT = 12.9352
const LON = 77.6245
const QUERY = process.argv[2] || 'milk'

function dump(name: string, data: unknown) {
  mkdirSync(OUT, { recursive: true })
  const file = `${OUT}/blinkit-${name}.json`
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  console.log(`  wrote ${file}`)
}

async function main() {
  console.log('[1] launch chromium (headful — Cloudflare is lenient on a real browser)')
  const ctx = await chromium.launchPersistentContext(`${OUT}/../.playwright-probe`, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    geolocation: { latitude: LAT, longitude: LON },
    permissions: ['geolocation'],
    locale: 'en-IN',
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())

  // Sniff the app's own /v1/layout/* traffic to lift the exact required header
  // set (auth_key, app_version, device_id, session_uuid, lat/lon).
  const headerSamples: Record<string, Record<string, string>> = {}
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('/v1/layout/') || url.includes('/v5/carts')) {
      const key = new URL(url).pathname
      if (!headerSamples[key]) headerSamples[key] = req.headers()
    }
  })

  console.log('[2] navigate blinkit.com (clears Cloudflare, sets cookies)')
  await page.goto('https://blinkit.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)

  // Set delivery location by cookie (the web app reads gr_1_lat/gr_1_lon).
  await ctx.addCookies([
    { name: 'gr_1_lat', value: String(LAT), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_lon', value: String(LON), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_locality', value: '0', domain: '.blinkit.com', path: '/' },
  ])
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(5000)

  console.log('[3] captured header samples from live traffic:')
  console.log(JSON.stringify(headerSamples, null, 2))
  dump('headers', headerSamples)

  // Replay a search from inside the page (same-origin fetch → real TLS + cookies).
  console.log(`[4] search "${QUERY}" via page.evaluate(fetch)`)
  const search = await page.evaluate(
    async ({ q, lat, lon }) => {
      const res = await fetch(
        `/v1/layout/search?q=${encodeURIComponent(q)}&search_type=type_to_search`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            app_client: 'consumer_web',
            lat: String(lat),
            lon: String(lon),
          },
          body: '{}',
        },
      )
      const text = await res.text()
      return { status: res.status, ok: res.ok, len: text.length, body: text.slice(0, 200_000) }
    },
    { q: QUERY, lat: LAT, lon: LON },
  )
  console.log(`  status=${search.status} ok=${search.ok} len=${search.len}`)
  dump('search-raw', search.body)

  await ctx.close()
  console.log('[done] inspect scratchpad/blinkit-*.json')
}
void main().catch((e) => {
  console.error('PROBE FAILED:', e)
  process.exit(1)
})
