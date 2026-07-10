/**
 * Pure browser-automation UC booking (DOM locators, not API). Drives the whole
 * flow in the user's logged-in Chrome via CDP (past the captcha): category → Add
 * package → pick size → cart → checkout → select address → SLOT grid. STOPS
 * before payment. Builds in the user's ADDRESS city so no location-mismatch.
 *
 * Run: npx tsx scripts/uc-browser-book.ts   (UC_CITY_SLUG=kolkata, UC_SIZE="2 BHK")
 */
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'

const OUT = 'scratchpad/uc/ui'
const CITY = process.env.UC_CITY_SLUG || 'kolkata'
const SIZE = process.env.UC_SIZE || '2 BHK'

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {})
  console.log(`  📸 ${name}  ${page.url().replace(/https:\/\/www\.urbancompany\.com/, '')}`)
}
async function ctrls(page: Page): Promise<string[]> {
  return page.$$eval('button,[role="button"]', (els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 40)).catch(() => [])
}
async function click(page: Page, re: RegExp, note = ''): Promise<boolean> {
  for (const loc of [page.getByRole('button', { name: re }), page.getByText(re)]) {
    const el = loc.first()
    if (!(await el.count().then((c) => c > 0).catch(() => false))) continue
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
    if (await el.click({ timeout: 4000, force: true }).then(() => true).catch(() => false)) {
      console.log(`  ✓ ${note || re}`)
      return true
    }
  }
  console.log(`  ✗ ${note || re}`)
  return false
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 8000 })
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => /urban/.test(p.url())) ?? (await ctx.newPage())

  console.log(`→ category page (${CITY})`)
  await page.goto(`https://www.urbancompany.com/${CITY}-professional-home-cleaning`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)
  await shot(page, '0-category')

  console.log('\n→ Add package → requirements → confirm')
  await click(page, /^Add/, 'Add package')
  await page.waitForTimeout(3000)
  // Satisfy the modal's required sections. Each add-on is an "Add" BUTTON inside
  // a card — click the Add button that FOLLOWS the free (₹0) option's label, and
  // re-check each cycle (resolving one section can expand the next).
  const addAfter = async (label: RegExp, note: string) => {
    const btn = page.getByText(label).first().locator('xpath=following::button[normalize-space()="Add"][1]')
    if (await btn.click({ timeout: 3000, force: true }).then(() => true).catch(() => false)) console.log(`  ✓ add-on: ${note}`)
  }
  await page.getByText(new RegExp(`^${SIZE}$`, 'i')).first().click({ timeout: 3000, force: true }).catch(() => {})
  await page.waitForTimeout(800)
  for (let i = 0; i < 4; i++) {
    // expand any collapsed section, then add its free option
    await page.getByText(/select kitchen cabinets|select sofa & mattress|select extra room/i).first().click({ timeout: 2000, force: true }).catch(() => {})
    await page.waitForTimeout(500)
    await addAfter(/dry vacuuming/i, 'Dry vacuuming ₹0')
    await addAfter(/cabinet exterior & stove/i, 'Cabinet exterior & stove ₹0')
    await page.waitForTimeout(700)
    const doneEnabled = await page.getByRole('button', { name: /^Done/ }).first().isEnabled().catch(() => false)
    if (doneEnabled) {
      console.log('  ✓ Done is now enabled')
      break
    }
  }
  await page.waitForTimeout(800)
  await shot(page, '2-requirements')
  ;(await click(page, /^Done/, 'Done')) || (await click(page, /^Add ₹/, 'Add ₹'))
  await page.waitForTimeout(3000)

  console.log('\n→ cart → checkout')
  ;(await click(page, /view cart/i, 'View Cart')) || (await click(page, /checkout|proceed/i, 'Checkout'))
  await page.waitForTimeout(4000)
  await shot(page, '3-checkout')

  console.log('\n→ select address')
  await click(page, /select address/i, 'Select address')
  await page.waitForTimeout(3000)
  await page.locator('[role="radio"], input[type="radio"]').first().click({ timeout: 4000, force: true }).catch(() => page.getByText(/^Home$/).first().click({ force: true }).catch(() => {}))
  await page.waitForTimeout(1200)
  await click(page, /^proceed/i, 'Proceed (address)')
  await page.waitForTimeout(4500)
  await shot(page, '4-after-address')
  // If a location-change dialog appears (address city ≠ cart city), we DON'T
  // blow the cart away — log it; building in the address city avoids it.
  if (await page.getByText(/update your location|rebuild your cart/i).count().then((c) => c > 0).catch(() => false)) {
    console.log('  ⚠ location-mismatch dialog appeared — cart city ≠ address city (should not happen when CITY = address city)')
  }

  console.log('\n→ slot grid')
  await click(page, /^slot$|select.*slot|pick.*slot/i, 'open Slot')
  await page.waitForTimeout(5000)
  await shot(page, '5-slots')
  console.log(`\nFINAL ${page.url().replace(/https:\/\/www\.urbancompany\.com/, '')}`)
  console.log(`controls: ${[...new Set(await ctrls(page))].slice(0, 22).join(' | ')}`)
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
