/**
 * Capture the REAL share-cart payload + resulting link: load the saved session,
 * open the cart, click the "share" control, and sniff POST /v1/assist/cart/share
 * (request body + response link). Headful for reliable clicking.
 *
 *   npx tsx scripts/blinkit-share-capture.ts
 */
import './preload'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'
const AUTH_FILE = process.env.BLINKIT_AUTH_FILE ?? '.playwright/blinkit-auth.storageState.json'
const LAT = 12.9352
const LON = 77.6245

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    ignoreDefaultArgs: ['--enable-automation'],
  })
  const ctx = await browser.newContext({ storageState: AUTH_FILE, viewport: { width: 1280, height: 900 }, locale: 'en-IN' })
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }))
  await ctx.addCookies([
    { name: 'gr_1_lat', value: String(LAT), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_lon', value: String(LON), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_locality', value: '0', domain: '.blinkit.com', path: '/' },
  ])
  const page = await ctx.newPage()

  const shares: Array<{ method: string; reqBody?: string; status?: number; resBody?: string }> = []
  page.on('request', (r) => {
    if (r.url().includes('assist/cart/share')) shares.push({ method: r.method(), reqBody: r.postData() ?? undefined })
  })
  page.on('response', async (r) => {
    if (r.url().includes('assist/cart/share')) {
      const rec = shares[shares.length - 1]
      if (rec) {
        rec.status = r.status()
        rec.resBody = await r.text().catch(() => undefined)
      }
    }
  })

  console.log('[1] load session, add an item so the cart is non-empty')
  await page.goto('https://blinkit.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)
  const searchBox = page.locator('input[type="text"], input[placeholder*="earch" i]').first()
  await searchBox.click({ timeout: 4000 }).catch(() => {})
  await searchBox.fill('milk').catch(() => {})
  await page.waitForTimeout(3000)
  for (const sel of ['button:has-text("ADD")', 'text=/^ADD$/']) {
    const a = page.locator(sel).first()
    if (await a.isVisible({ timeout: 1500 }).catch(() => false)) {
      await a.click({ timeout: 3000 }).catch(() => {})
      break
    }
  }
  await page.waitForTimeout(2000)

  console.log('[2] open the cart')
  for (const sel of ['text=/my cart/i', 'text=/view cart/i', '[class*="cart" i]']) {
    const c = page.locator(sel).first()
    if (await c.isVisible({ timeout: 1500 }).catch(() => false)) {
      await c.click({ timeout: 3000 }).catch(() => {})
      break
    }
  }
  await page.waitForTimeout(3000)
  mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: `${OUT}/blinkit-share-cart.png` }).catch(() => {})

  console.log('[3] click a "share" control in the cart')
  const shareSelectors = ['text=/share/i', '[class*="share" i]', 'img[src*="share" i]', 'button[aria-label*="share" i]']
  for (const sel of shareSelectors) {
    const s = page.locator(sel).first()
    if (await s.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log(`   click ${sel}`)
      await s.click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(3000)
      break
    }
  }
  await page.screenshot({ path: `${OUT}/blinkit-share-after.png` }).catch(() => {})

  console.log(`[4] ${shares.length} share calls captured`)
  writeFileSync(`${OUT}/blinkit-share-capture.json`, JSON.stringify(shares, null, 2))
  for (const s of shares) {
    console.log(`   ${s.method} → ${s.status}`)
    console.log(`     req: ${s.reqBody?.slice(0, 300)}`)
    const links = [...(s.resBody ?? '').matchAll(/https?:\/\/[^"'\\ ]+/g)].map((m) => m[0]).filter((u) => /blinkit|grofers|share|cart|prid/i.test(u))
    console.log(`     link(s): ${[...new Set(links)].slice(0, 5).join('  |  ') || '(see dump)'}`)
    console.log(`     resp: ${s.resBody?.slice(0, 200)}`)
  }
  await page.waitForTimeout(1500)
  await ctx.close()
  await browser.close()
}
void main().catch((e) => {
  console.error('SHARE CAPTURE FAILED:', e)
  process.exit(1)
})
