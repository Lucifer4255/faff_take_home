/**
 * Capture Blinkit's location / serviceability flow (DESIGN.md §12.1 step 1).
 * Logs every XHR/fetch during navigation + a "detect my location" attempt, so we
 * learn which endpoint pins the dark-store for a lat/lon — then search results
 * are scoped to the intended address, not a default store.
 *
 * Run: npx tsx scripts/blinkit-loc-probe.ts
 */
import './preload'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'
const LAT = 12.9352
const LON = 77.6245

async function main() {
  const ctx = await chromium.launchPersistentContext(`${OUT}/../.playwright-loc`, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    geolocation: { latitude: LAT, longitude: LON },
    permissions: ['geolocation'],
    locale: 'en-IN',
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())

  const calls: { method: string; url: string; body?: string }[] = []
  page.on('request', (req) => {
    const url = req.url()
    if (/blinkit\.com|grofers/.test(url) && (req.resourceType() === 'xhr' || req.resourceType() === 'fetch')) {
      calls.push({ method: req.method(), url, body: req.postData() ?? undefined })
    }
  })
  const responses: Record<string, unknown> = {}
  page.on('response', async (res) => {
    const url = res.url()
    if (/location|serviceab|geocode|address|merchant|reverse|latlng|place/i.test(url)) {
      try {
        responses[new URL(url).pathname] = await res.json()
      } catch {
        /* non-json */
      }
    }
  })

  console.log('[1] navigate blinkit.com')
  await page.goto('https://blinkit.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)

  // Try to trigger location detection. Blinkit shows a location bar/pill; the
  // "Detect my location" button uses the browser geolocation we granted.
  console.log('[2] look for a location control')
  const candidates = [
    'text=/detect.*location/i',
    'text=/current location/i',
    '[class*="LocationBar"]',
    '[class*="location"]',
    'text=/select.*location/i',
  ]
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first()
      if (await el.isVisible({ timeout: 1500 })) {
        console.log(`   click ${sel}`)
        await el.click({ timeout: 3000 })
        await page.waitForTimeout(2500)
        // a modal may now offer detect-location
        const detect = page.locator('text=/detect.*location/i, text=/current location/i').first()
        if (await detect.isVisible({ timeout: 1500 }).catch(() => false)) {
          await detect.click({ timeout: 3000 })
          await page.waitForTimeout(3000)
        }
        break
      }
    } catch {
      /* try next */
    }
  }
  await page.waitForTimeout(2000)

  const locCalls = calls.filter((c) => /location|serviceab|geocode|address|merchant|reverse|latlng|place|lat|lon/i.test(c.url))
  console.log(`[3] ${calls.length} total API calls; ${locCalls.length} location-ish:`)
  for (const c of locCalls) console.log(`   ${c.method} ${c.url.slice(0, 140)}`)
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/blinkit-loc-calls.json`, JSON.stringify({ locCalls, allUrls: calls.map((c) => `${c.method} ${c.url}`) }, null, 2))
  writeFileSync(`${OUT}/blinkit-loc-responses.json`, JSON.stringify(responses, null, 2))
  console.log('   wrote blinkit-loc-calls.json + blinkit-loc-responses.json')

  await ctx.close()
}
void main().catch((e) => {
  console.error('LOC PROBE FAILED:', e)
  process.exit(1)
})
