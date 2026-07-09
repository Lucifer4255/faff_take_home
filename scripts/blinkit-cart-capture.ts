/**
 * Capture the /v5/carts ITEM shape (B4) using the saved login session — no OTP
 * needed. Loads the session, adds one item via the UI, and sniffs the resulting
 * POST /v5/carts so we learn the item object shape for push-cart-under-auth.
 *
 *   npx tsx scripts/blinkit-cart-capture.ts
 */
import './preload'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'
const AUTH_FILE = process.env.BLINKIT_AUTH_FILE ?? '.playwright/blinkit-auth.storageState.json'
const LAT = Number(process.env.BLINKIT_LAT ?? 12.9352)
const LON = Number(process.env.BLINKIT_LON ?? 77.6245)

async function main() {
  if (!existsSync(AUTH_FILE)) throw new Error(`no saved session at ${AUTH_FILE} — run blinkit-login-capture first`)
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

  const carts: Array<{ reqBody?: string; authHeaders?: Record<string, string>; status?: number; resBody?: string }> = []
  page.on('request', (r) => {
    if (r.url().includes('/v5/carts') && r.method() === 'POST') {
      const h = r.headers()
      // Which header carries the logged-in identity? (for per-user token injection)
      const authHeaders: Record<string, string> = {}
      for (const k of ['access_token', 'auth_key', 'authorization', 'device_id', 'session_uuid']) {
        if (h[k]) authHeaders[k] = k === 'access_token' || k === 'authorization' ? `${h[k].slice(0, 6)}…(${h[k].length} chars)` : h[k]
      }
      carts.push({ reqBody: r.postData() ?? undefined, authHeaders })
    }
  })
  page.on('response', async (r) => {
    if (r.url().includes('/v5/carts') && r.request().method() === 'POST') {
      const rec = carts[carts.length - 1]
      if (rec && rec.status === undefined) {
        rec.status = r.status()
        rec.resBody = await r.text().then((t) => t.slice(0, 800)).catch(() => undefined)
      }
    }
  })

  console.log('[1] load session, search via the search box')
  await page.goto('https://blinkit.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)
  const search = page.locator('input[type="text"], input[type="search"], input[placeholder*="earch" i]').first()
  await search.click({ timeout: 4000 }).catch(() => {})
  await search.fill('milk').catch(() => {})
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${OUT}/blinkit-cart-1-search.png` }).catch(() => {})

  console.log('[2] click the first ADD button')
  const addSelectors = ['button:has-text("ADD")', 'button:has-text("Add")', 'text=/^ADD$/', '[class*="AddToCart" i]', 'div[role="button"]:has-text("ADD")']
  let added = false
  for (const sel of addSelectors) {
    const add = page.locator(sel).first()
    if (await add.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log(`   click ${sel}`)
      await add.click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(2500)
      added = true
      break
    }
  }
  if (!added) console.log('   no ADD button matched')
  await page.screenshot({ path: `${OUT}/blinkit-cart-2-added.png` }).catch(() => {})

  console.log('[3] open cart to force a /v5/carts sync')
  for (const sel of ['text=/my cart/i', '[class*="cart" i]', 'text=/view cart/i']) {
    const c = page.locator(sel).first()
    if (await c.isVisible({ timeout: 1500 }).catch(() => false)) {
      await c.click({ timeout: 3000 }).catch(() => {})
      break
    }
  }
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${OUT}/blinkit-cart-3-cart.png` }).catch(() => {})

  const withItems = carts.find((c) => c.reqBody?.includes('product_id') || (c.reqBody && c.reqBody.length > 40))
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/blinkit-cart-shape.json`, JSON.stringify(carts, null, 2))
  console.log(`[4] ${carts.length} /v5/carts POSTs captured → scratchpad/blinkit-cart-shape.json`)
  const sample = withItems ?? carts[carts.length - 1]
  if (sample) {
    console.log('   auth headers on /v5/carts:', JSON.stringify(sample.authHeaders))
    console.log('   body:')
    try {
      console.log(JSON.stringify(JSON.parse(sample.reqBody as string), null, 1).slice(0, 1800))
    } catch {
      console.log(sample.reqBody?.slice(0, 1200))
    }
  }
  await page.waitForTimeout(1000)
  await ctx.close()
  await browser.close()
}
void main().catch((e) => {
  console.error('CART CAPTURE FAILED:', e)
  process.exit(1)
})
