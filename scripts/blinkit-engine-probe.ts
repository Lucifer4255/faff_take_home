/**
 * Test which real browser ENGINE passes Blinkit's Cloudflare headless, so the
 * identity pool is built only from engines that actually work. Each engine is
 * genuine (real Gecko/WebKit/Blink TLS + JS), not a UA-spoof on top of Chromium.
 *
 *   ENGINE=chromium npx tsx scripts/blinkit-engine-probe.ts
 *   ENGINE=firefox  npx tsx scripts/blinkit-engine-probe.ts
 *   ENGINE=webkit   npx tsx scripts/blinkit-engine-probe.ts
 */
import './preload'
import { type BrowserType, chromium, firefox, webkit } from 'playwright'

const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'
const ENGINE = (process.env.ENGINE ?? 'chromium') as 'chromium' | 'firefox' | 'webkit'
const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit }
const LAT = 12.9352
const LON = 77.6245

// Engine-consistent UAs (real recent builds).
const UA: Record<string, string> = {
  chromium: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
  webkit: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
}

async function main() {
  const type = ENGINES[ENGINE]
  console.log(`[probe] engine=${ENGINE} headless=true`)
  const browser = await type.launch({
    headless: true,
    ...(ENGINE === 'chromium'
      ? { args: ['--disable-blink-features=AutomationControlled', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], ignoreDefaultArgs: ['--enable-automation'] }
      : {}),
  })
  const ctx = await browser.newContext({
    userAgent: UA[ENGINE],
    viewport: { width: 1280, height: 900 },
    locale: 'en-IN',
    geolocation: { latitude: LAT, longitude: LON },
    permissions: ['geolocation'],
  })
  // Engine-aware stealth: webdriver=false everywhere; window.chrome ONLY on Blink.
  await ctx.addInitScript((engine) => {
    // biome-ignore lint: browser globals
    const nav = navigator as any
    Object.defineProperty(nav, 'webdriver', { get: () => false, configurable: true })
    if (engine === 'chromium') {
      // biome-ignore lint: browser globals
      const win = window as any
      if (!win.chrome) win.chrome = { runtime: {} }
    }
  }, ENGINE)

  const page = await ctx.newPage()
  await page.goto('https://blinkit.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3500)
  await ctx.addCookies([
    { name: 'gr_1_lat', value: String(LAT), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_lon', value: String(LON), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_locality', value: '0', domain: '.blinkit.com', path: '/' },
  ])
  const r = await page.evaluate(async ({ LAT, LON }) => {
    const headers = { 'content-type': 'application/json', app_client: 'consumer_web', lat: String(LAT), lon: String(LON) }
    await fetch(`/location/info?lat=${LAT}&lon=${LON}&is_pin_moved=false`, { headers }).catch(() => {})
    const res = await fetch('/v1/layout/search?q=milk&search_type=type_to_search', { method: 'POST', headers, body: '{}' })
    const t = await res.text()
    return { status: res.status, ok: res.ok, len: t.length, sample: t.slice(0, 120) }
  }, { LAT, LON })
  const cf = r.len > 5000 || /challenge|cloudflare|cf-|captcha/i.test(r.sample)
  console.log(`  → HTTP ${r.status} len=${r.len} ${r.ok ? '✅ PASS' : cf ? '❌ CLOUDFLARE' : `⚠️ API ${r.status}`}`)
  if (!r.ok) console.log(`     body: ${r.sample}`)
  await browser.close()
}
void main().catch((e) => {
  console.error(`ENGINE PROBE (${ENGINE}) FAILED:`, e)
  process.exit(1)
})
