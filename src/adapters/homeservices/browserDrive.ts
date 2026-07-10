import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

/**
 * Home-services "just pay" handoff — Tier B replacement (2026-07-11 pivot).
 *
 * Why this exists over the pure headless-API path (booking.ts): UC's checkout
 * has no resume-by-URL (verified live: cold-opening `journey/checkout?...
 * &draftOrderId=...` ignores the draftOrderId and loads the PERSISTENT cart
 * with address+slot reset), and the API layer + DOM modal shape both turned
 * out to be category-specific, not generic (verified against AC service: a
 * different modal pattern, a 500 on `initiateJourney` from a missing
 * `x-session-id` header). So instead of building a draft the human can never
 * cleanly resume, this drives a REAL local Chrome — on the user's own
 * machine, injected with their already-captured session (auth.ts) — through
 * the actual booking UI to the parked "Proceed to pay" screen, in ONE
 * continuous session. State (address, slot) persists because we never leave
 * the SPA. The user finishes with a single click in that window. Proven 3/3
 * reliable for home-cleaning packages (scripts/uc-drive-to-pay.ts).
 *
 * SCOPE: home-cleaning category only for now. A different category's Add
 * modal is a different shape (verified against AC — grouped-mandatory-steps
 * doesn't hold everywhere) and would need its own pass.
 */

const DRIVE_CDP_PORT = 9236 // distinct from auth.ts's login-capture port (9235)
const DRIVE_CDP_URL = `http://localhost:${DRIVE_CDP_PORT}`

export interface DriveAuth {
  token: string
  ucUserId?: string
  name?: string
}

export interface DriveResult {
  ok: boolean
  note: string
  slotLabel?: string
  amountToPay?: string
  screenshotPath?: string
}

function chromeBinary(): string {
  return process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome'
}

async function cdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`${DRIVE_CDP_URL}/json/version`)
    return res.ok
  } catch {
    return false
  }
}

async function ensureDriveChrome(categoryUrl: string): Promise<void> {
  if (await cdpUp()) return
  const profile = `/tmp/uc-drive-${Date.now()}`
  const child = spawn(chromeBinary(), [`--remote-debugging-port=${DRIVE_CDP_PORT}`, `--user-data-dir=${profile}`, '--new-window', categoryUrl], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Chrome did not come up on :${DRIVE_CDP_PORT}`)
}

// biome-ignore lint/suspicious/noExplicitAny: Playwright Page typed loosely to match the proven PoC
type Page = any

/** Click `text`, wait for `expect` to appear, retrying the click if the SPA
 * no-ops (UC's react-native-web DOM regularly does on the first click). */
async function tapUntil(page: Page, text: RegExp, expect: RegExp, label: string, tries = 4): Promise<void> {
  const vis = (t: RegExp) => page.getByText(t, { exact: false }).filter({ visible: true })
  for (let i = 0; i < tries; i++) {
    const loc = vis(text).first()
    await loc.waitFor({ state: 'visible', timeout: 15000 })
    await loc.scrollIntoViewIfNeeded().catch(() => {})
    await loc.click({ force: true })
    try {
      await vis(expect).first().waitFor({ state: 'visible', timeout: 6000 })
      return
    } catch {
      await page.waitForTimeout(1200)
    }
  }
  throw new Error(`[${label}] never advanced to /${expect.source}/`)
}

async function tap(page: Page, text: RegExp, opts: { exact?: boolean; nth?: number; timeout?: number } = {}): Promise<void> {
  const vis = (t: RegExp) => page.getByText(t, { exact: opts.exact ?? false }).filter({ visible: true })
  const loc = vis(text).nth(opts.nth ?? 0)
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 15000 })
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  await loc.click({ force: true })
}

/** Ensure the target package is in the cart: if a "View Cart" affordance is
 * already showing, it's there (persistent cart from a prior run/session) —
 * skip. Otherwise search it out, click Add, and fill the "Select
 * requirements" modal — home-cleaning's shape is N mandatory single-select
 * groups (size, then usually kitchen + sofa/mattress bases); keep picking the
 * first/cheapest option of the next unanswered visible group until "Done"
 * unlocks (bounded loop; a genuinely different modal shape fails loud here
 * rather than silently misbooking). */
async function ensureCart(page: Page, packageName: string): Promise<void> {
  const vis = (t: RegExp) => page.getByText(t, { exact: false }).filter({ visible: true })
  const hasCart = await vis(/^View Cart$/).count().catch(() => 0)
  if (hasCart > 0) return

  // Click Add on the card whose heading matches packageName (nearest Add
  // button by vertical position — the card layout puts Add beside/below the
  // heading, and DOM order isn't reliable across category shapes).
  const heading = vis(new RegExp(packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first()
  await heading.waitFor({ state: 'visible', timeout: 15000 })
  const headBox = await heading.boundingBox()
  if (!headBox) throw new Error(`[ensureCart] package "${packageName}" not visible`)
  const addButtons = page.getByRole('button', { name: /^add$/i }).filter({ visible: true })
  const count = await addButtons.count()
  let bestIdx = 0
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = 0; i < count; i++) {
    const box = await addButtons.nth(i).boundingBox().catch(() => null)
    if (!box) continue
    const dist = Math.abs(box.y - headBox.y)
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
  }
  await addButtons.nth(bestIdx).click({ force: true })
  await page.waitForTimeout(2500)

  // Fill the customization modal: keep advancing the first unanswered visible
  // group until Done enables, or bail after a bounded number of tries.
  for (let round = 0; round < 6; round++) {
    const doneEnabled = await page
      .getByRole('button', { name: /^done$/i })
      .filter({ visible: true })
      .first()
      .isEnabled()
      .catch(() => false)
    if (doneEnabled) break

    // A group's options render as cards; some cards have their own "Add"
    // (multi-item groups like sofa/mattress) rather than being directly
    // clickable — prefer an "Add" inside the option area if present.
    const optionAdd = page.getByRole('button', { name: /^add$/i }).filter({ visible: true }).first()
    const hasOptionAdd = await optionAdd.count().catch(() => 0)
    if (hasOptionAdd > 0) {
      await optionAdd.click({ force: true })
    } else {
      // Fall back to the first visible, unselected option-looking text near a
      // ₹ price or a plain size label (e.g. "1 bhk") — click it directly.
      const candidate = page
        .locator('text=/₹\\d|^\\d\\s*bhk$/i')
        .filter({ visible: true })
        .first()
      const has = await candidate.count().catch(() => 0)
      if (has === 0) break // nothing left to click — likely already complete or an unknown shape
      await candidate.click({ force: true }).catch(() => {})
    }
    await page.waitForTimeout(1500)
  }

  await page.getByRole('button', { name: /^done$/i }).first().click({ force: true, timeout: 8000 })
  await page.waitForTimeout(3000)
}

/** Drive a logged-in local Chrome through home-cleaning checkout to the
 * parked "Proceed to pay" state. Never clicks pay. */
export async function driveToPay(opts: {
  citySlug: string
  cityKey: string
  categoryKey: string
  packageName: string
  addressHint?: string
  auth: DriveAuth
  screenshotDir?: string
}): Promise<DriveResult> {
  const categoryUrlSlug = opts.categoryKey.replace(/_/g, '-')
  const categoryUrl = `https://www.urbancompany.com/${opts.citySlug}-${categoryUrlSlug}`

  await ensureDriveChrome(categoryUrl)
  const browser = await chromium.connectOverCDP(DRIVE_CDP_URL, { timeout: 8000 })
  try {
    const ctx = browser.contexts()[0]
    if (!ctx) throw new Error('no browser context over CDP')

    const cookies = [
      { name: '_uc_user_token', value: opts.auth.token },
      ...(opts.auth.ucUserId ? [{ name: '_uc_user_id', value: opts.auth.ucUserId }] : []),
      ...(opts.auth.name ? [{ name: '_uc_user_name', value: encodeURIComponent(opts.auth.name) }] : []),
    ]
    for (const domain of ['.urbancompany.com', '.urbanclap.com']) {
      await ctx.addCookies(cookies.map((c) => ({ ...c, domain, path: '/', secure: true, sameSite: 'Lax' as const })))
    }

    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    const bodyText: string = await page.evaluate('document.body.innerText')
    if (/\bLog ?in\b|\bSign ?up\b/i.test(bodyText)) {
      return { ok: false, note: 'Session cookie injection did not log the browser in — needs a fresh human login.' }
    }

    await ensureCart(page, opts.packageName)

    await tapUntil(page, /^View Cart$/, /Select address|Proceed to pay/, 'View Cart→checkout')

    // Address: only drive the picker if it's still unset (a persistent cart
    // reused from a prior run may already have one).
    const needsAddress = await page.getByText(/Select address/, { exact: false }).filter({ visible: true }).count().catch(() => 0)
    if (needsAddress > 0) {
      await tapUntil(page, /Select address/, /Saved addresses|Add another address/, 'open address modal')
      if (opts.addressHint) {
        await tap(page, new RegExp(opts.addressHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).catch(async () => {
          await tap(page, /^Home$/, { nth: 0 })
        })
      } else {
        await tap(page, /^Home$/, { nth: 0 })
      }
      await tapUntil(page, /^Proceed$/, /professional arrive|Finding available|Select start time/, 'Proceed(address)→slot')
    }

    // Slot: only drive it if still unset.
    const needsSlot = await page.getByText(/^Slot$/, { exact: true }).filter({ visible: true }).count().catch(() => 0)
    const timeGridVisible = await page
      .getByText(/^\d{1,2}:\d{2}\s*(AM|PM)$/)
      .filter({ visible: true })
      .count()
      .catch(() => 0)
    if (needsSlot > 0 || timeGridVisible > 0) {
      await page.getByText(/^\d{1,2}:\d{2}\s*(AM|PM)$/, { exact: false }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 20000 })
      await tap(page, /^\d{1,2}:\d{2}\s*(AM|PM)$/)
      await tapUntil(page, /Proceed to checkout/, /Proceed to pay/, 'Proceed to checkout→pay')
    }

    const finalText: string = await page.evaluate('document.body.innerText')
    const atPay = /proceed to pay/i.test(finalText)
    const slotLabel = finalText.match(/Slot[\s\S]{0,10}?([A-Za-z]{3},\s*[A-Za-z]{3}\s*\d{1,2}\s*-\s*\d{1,2}:\d{2}\s*(AM|PM))/i)?.[1]
    const amountToPay = finalText.match(/Amount to pay[\s\S]{0,10}?(₹[\d,]+)/i)?.[1]

    let screenshotPath: string | undefined
    if (opts.screenshotDir) {
      screenshotPath = `${opts.screenshotDir}/parked-${Date.now()}.png`
      await page.screenshot({ path: screenshotPath }).catch(() => {
        screenshotPath = undefined
      })
    }

    return {
      ok: atPay,
      note: atPay ? 'Parked at "Proceed to pay" in a real, logged-in browser window — nothing charged.' : 'Drove the flow but did not detect "Proceed to pay" — inspect the window.',
      slotLabel,
      amountToPay,
      screenshotPath,
    }
  } finally {
    await browser.close().catch(() => {}) // detaches CDP only; leaves the window open for the user
  }
}
