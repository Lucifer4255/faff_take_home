/**
 * Discover Blinkit's address AUTOCOMPLETE + place-details endpoints (for the
 * "type an address → pick from options → pin location" fallback flow). Drives
 * the location modal, types an address, and sniffs every XHR so we learn the
 * request/response shape. Locators are used ONLY to trigger the calls — the
 * adapter will hit the JSON endpoint directly.
 *
 *   npx tsx scripts/blinkit-address-probe.ts "koramangala"
 */
import './preload'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'
const QUERY = process.argv[2] || 'koramangala'

async function main() {
  const ctx = await chromium.launchPersistentContext(`${OUT}/../.playwright-addr`, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'en-IN',
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())

  const calls: { method: string; url: string; body?: string }[] = []
  const responses: Record<string, unknown> = {}
  page.on('request', (req) => {
    const u = req.url()
    if (/autocomplete|places?|geocode|suggest|address|location|search|maps|serviceab/i.test(u) && (req.resourceType() === 'xhr' || req.resourceType() === 'fetch')) {
      calls.push({ method: req.method(), url: u, body: req.postData() ?? undefined })
    }
  })
  page.on('response', async (res) => {
    const u = res.url()
    if (/autocomplete|suggest|places?\b|geocode|address/i.test(u)) {
      try {
        responses[u.split('?')[0]] = await res.json()
      } catch {
        /* non-json */
      }
    }
  })

  console.log('[1] navigate + open location search')
  await page.goto('https://blinkit.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3500)

  // Open the location entry (the top-left "select location" affordance), then the
  // "search delivery location" input. Try several selectors defensively.
  const openers = ['text=/select location/i', 'text=/detect/i', '[class*="LocationBar"]', '[class*="location"]', 'header button']
  for (const sel of openers) {
    const el = page.locator(sel).first()
    if (await el.isVisible({ timeout: 1200 }).catch(() => false)) {
      await el.click({ timeout: 2500 }).catch(() => {})
      await page.waitForTimeout(1500)
      break
    }
  }
  // Type into whatever search input is now visible.
  const input = page.locator('input[type="text"], input[placeholder*="ocation" i], input[placeholder*="earch" i]').first()
  if (await input.isVisible({ timeout: 2500 }).catch(() => false)) {
    console.log('[2] typing address into the location search box')
    await input.click({ timeout: 2500 }).catch(() => {})
    await input.type(QUERY, { delay: 120 })
    await page.waitForTimeout(3000)
    // Click the first suggestion → capture the place-details (place_id → latlng) call.
    const suggestion = page.locator(`text=/${QUERY}/i`).nth(1)
    if (await suggestion.isVisible({ timeout: 2500 }).catch(() => false)) {
      console.log('[2b] clicking first suggestion to capture place-details endpoint')
      await suggestion.click({ timeout: 2500 }).catch(() => {})
      await page.waitForTimeout(3000)
    }
  } else {
    console.log('[2] could not find a location search input — dumping all sniffed calls anyway')
  }

  const hits = calls.filter((c) => /autocomplete|suggest|places?|geocode|address/i.test(c.url))
  console.log(`[3] ${calls.length} location-ish calls; ${hits.length} autocomplete-ish:`)
  for (const c of hits) console.log(`   ${c.method} ${c.url.slice(0, 160)}`)
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/blinkit-address-calls.json`, JSON.stringify({ hits, all: calls.map((c) => `${c.method} ${c.url}`) }, null, 2))
  writeFileSync(`${OUT}/blinkit-address-responses.json`, JSON.stringify(responses, null, 2))
  console.log('   wrote blinkit-address-calls.json + blinkit-address-responses.json')
  await ctx.close()
}
void main().catch((e) => {
  console.error('ADDRESS PROBE FAILED:', e)
  process.exit(1)
})
