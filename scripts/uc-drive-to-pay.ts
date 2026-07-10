/**
 * PoC (plan: whimsical-meandering-wirth) — drive a REAL local Chrome, logged in
 * as the user, through the full UC home-services booking to the parked
 * "Proceed to pay" state. Proves the "local companion browser" handoff before
 * any adapter rework. NEVER clicks pay.
 *
 * Stage 1 (this file, current): spawn Chrome on CDP :9235 with a fresh profile,
 * inject the captured session cookies from .data/uc-auth.json, navigate to the
 * category page, and confirm the web UI is logged in. Later stages add the
 * booking drive.
 *
 * Run: npx tsx scripts/uc-drive-to-pay.ts
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const CDP_PORT = 9235
const CDP_URL = `http://localhost:${CDP_PORT}`
const CITY_SLUG = 'kolkata'
const CATEGORY_URL = `https://www.urbancompany.com/${CITY_SLUG}-professional-home-cleaning`
const SHOTS = 'scratchpad/uc/poc'

interface UCAuth {
  token: string
  ucUserId?: string
  name?: string
}

function loadAuth(): UCAuth {
  const store = JSON.parse(readFileSync('.data/uc-auth.json', 'utf8'))
  const first = Object.values(store)[0] as UCAuth
  if (!first?.token) throw new Error('no UC token in .data/uc-auth.json')
  return first
}

async function cdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`)
    return res.ok
  } catch {
    return false
  }
}

async function ensureChrome(): Promise<void> {
  if (await cdpUp()) {
    console.log(`✓ Chrome already listening on :${CDP_PORT}`)
    return
  }
  const profile = `/tmp/uc-poc-${Date.now()}`
  console.log(`· spawning google-chrome on :${CDP_PORT} (profile ${profile})`)
  const child = spawn(
    'google-chrome',
    [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--new-window', CATEGORY_URL],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) {
      console.log(`✓ Chrome up on :${CDP_PORT}`)
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Chrome did not come up on :${CDP_PORT}`)
}

async function main() {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true })
  const auth = loadAuth()
  console.log(`using session for ${auth.name ?? auth.ucUserId} (token len ${auth.token.length})`)

  await ensureChrome()
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 8000 })
  const ctx = browser.contexts()[0]
  if (!ctx) throw new Error('no browser context over CDP')

  // Inject the captured session cookies so the real Chrome UI is logged in,
  // reusing the app's captured token instead of a fresh human login.
  const cookies = [
    { name: '_uc_user_token', value: auth.token },
    ...(auth.ucUserId ? [{ name: '_uc_user_id', value: auth.ucUserId }] : []),
    ...(auth.name ? [{ name: '_uc_user_name', value: encodeURIComponent(auth.name) }] : []),
  ]
  for (const domain of ['.urbancompany.com', '.urbanclap.com']) {
    await ctx.addCookies(
      cookies.map((c) => ({ ...c, domain, path: '/', secure: true, sameSite: 'Lax' as const })),
    )
  }
  console.log(`✓ injected ${cookies.length} cookies × 2 domains`)

  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto(CATEGORY_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)

  // Login check: logged-out UC shows a "Login" affordance in the header; logged-in
  // shows the account/address. Report both signals.
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 6000))
  const cookieState = await page.evaluate(() => {
    const ck = Object.fromEntries(document.cookie.split('; ').map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)] }))
    return { hasToken: !!ck._uc_user_token, name: ck._uc_user_name ? decodeURIComponent(ck._uc_user_name) : null }
  })
  const looksLoggedOut = /\bLog ?in\b|\bSign ?up\b/i.test(bodyText) && !cookieState.hasToken

  await page.screenshot({ path: `${SHOTS}/01-loginstate.png` })
  console.log('\n— login state —')
  console.log('  cookie _uc_user_token present in page:', cookieState.hasToken)
  console.log('  cookie name:', cookieState.name)
  console.log('  → verdict:', looksLoggedOut ? 'LOGGED OUT (cookie injection insufficient)' : 'appears LOGGED IN')
  if (looksLoggedOut) throw new Error('not logged in — cannot drive booking')

  await drive(page)

  await browser.close() // detaches CDP only; leaves the Chrome window open
  console.log('\n✓ done — Chrome window left open, parked (never paid).')
}

// biome-ignore lint/suspicious/noExplicitAny: Playwright Page typed loosely for the PoC
type Page = any

/** Drive the logged-in category page → checkout → address → slot → parked at
 * "Proceed to pay". Reality-based selectors (UC's DOM is obfuscated RN-web;
 * "View Cart"/"Proceed" are clickable TEXT, not button roles). force:true beats
 * the sticky-header pointer interception. Screenshots each step; STOPS before pay. */
async function drive(page: Page): Promise<void> {
  const shot = async (n: string) => {
    await page.screenshot({ path: `${SHOTS}/${n}.png` }).catch(() => {})
    console.log(`  · ${n}.png`)
  }
  // UC is react-native-web: text often renders as hidden duplicate nodes, so a
  // plain getByText().nth(0) can grab an invisible copy. Always filter to visible.
  const vis = (text: RegExp, exact = false) => page.getByText(text, { exact }).filter({ visible: true })
  const tap = async (text: RegExp, label: string, opts: { exact?: boolean; nth?: number; timeout?: number } = {}) => {
    const loc = vis(text, opts.exact ?? false).nth(opts.nth ?? 0)
    await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 15000 })
    await loc.scrollIntoViewIfNeeded().catch(() => {})
    await loc.click({ force: true })
    console.log(`  → tapped ${label}`)
  }
  // Click `text`, then wait for `expect` to appear; retry the click if the SPA
  // didn't advance (UC modals often no-op on the first click). This is what makes
  // driving the flaky SPA reliable.
  const tapUntil = async (text: RegExp, expect: RegExp, label: string, tries = 4) => {
    for (let i = 0; i < tries; i++) {
      const loc = vis(text).first()
      await loc.waitFor({ state: 'visible', timeout: 15000 })
      await loc.scrollIntoViewIfNeeded().catch(() => {})
      await loc.click({ force: true })
      try {
        await vis(expect).first().waitFor({ state: 'visible', timeout: 6000 })
        console.log(`  → ${label} (advanced on try ${i + 1})`)
        return
      } catch {
        console.log(`    …${label}: no advance, retry ${i + 1}/${tries}`)
        await page.waitForTimeout(1200)
      }
    }
    throw new Error(`${label}: never advanced to /${expect.source}/`)
  }

  // STEP A — cart already holds the target package (+3 customizations); confirmed
  // by uc-poc-inspect. Go straight to checkout. (Add/customize path is proven in
  // the manual sweep; not re-driven here.)
  await shot('04-cart-ready')

  console.log('\n[B] View Cart → checkout')
  await tapUntil(/^View Cart$/, /Select address|Proceed to pay/, 'View Cart→checkout')
  await shot('05-checkout')

  console.log('\n[C] select address')
  await tapUntil(/Select address/, /Saved addresses|Add another address/, 'open address modal')
  await shot('06-address-list')
  // pick a concrete saved Kolkata address, then Proceed (wait for slot page).
  await tap(/Bansdroni Post Office Road/, 'saved address (Bansdroni)').catch(async () => {
    await tap(/^Home$/, 'first saved address', { nth: 0 })
  })
  await tapUntil(/^Proceed$/, /professional arrive|Finding available|Select start time/, 'Proceed(address)→slot')
  await shot('07-slot-loading')

  console.log('\n[D] pick slot (earliest)')
  await vis(/^\d{1,2}:\d{2}\s*(AM|PM)$/).first().waitFor({ state: 'visible', timeout: 20000 })
  await shot('08-slot-grid')
  await tap(/^\d{1,2}:\d{2}\s*(AM|PM)$/, 'earliest time')
  await tapUntil(/Proceed to checkout/, /Proceed to pay/, 'Proceed to checkout→pay')
  await shot('09-parked')

  console.log('\n[E] verify parked at pay')
  const finalText = (await page.evaluate('document.body.innerText')) as string
  const atPay = /proceed to pay/i.test(finalText)
  const slotLine = finalText.match(/Slot[\s\S]{0,40}?(\d{1,2}:\d{2}\s*(AM|PM))/i)?.[0]?.replace(/\s+/g, ' ')
  console.log('  "Proceed to pay" present:', atPay)
  console.log('  slot shown:', slotLine ?? '(not detected)')
  console.log('  → RESULT:', atPay ? '✅ PARKED AT PAY (never clicked)' : '⚠ did NOT reach pay — inspect 09-parked.png')
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
