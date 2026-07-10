/**
 * Continue the browser-automation booking from the checkout page: Select address
 * → pick saved address → reach the real SLOT grid. STOPS before payment.
 * Run after uc-browser-book.ts (Chrome is on /journey/checkout).
 *
 * Run: npx tsx scripts/uc-browser-slot.ts
 */
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'

const OUT = 'scratchpad/uc/ui'
async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {})
  console.log(`  📸 ${name}  url=${page.url()}`)
}
async function ctrls(page: Page): Promise<string[]> {
  return page
    .$$eval('button, [role="button"], a', (els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 45))
    .catch(() => [])
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 8000 })
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => /checkout|urban/.test(p.url())) ?? ctx.pages()[0]
  console.log(`on: ${page.url()}`)

  console.log('\n→ Select address')
  await page.getByRole('button', { name: /select address/i }).first().click({ timeout: 6000, force: true }).catch(async () => {
    await page.getByText(/select address/i).first().click({ timeout: 4000, force: true }).catch(() => console.log('  ✗ select address'))
  })
  await page.waitForTimeout(3500)
  await shot(page, '6-address-list')
  console.log(`  controls: ${[...new Set(await ctrls(page))].slice(0, 18).join(' | ')}`)

  // Tick the address radio (the "Home" card), then Proceed enables.
  console.log('\n→ tick address radio')
  const radio = page.locator('[role="radio"], input[type="radio"]').first()
  if (await radio.count().then((c) => c > 0).catch(() => false)) {
    await radio.click({ timeout: 4000, force: true }).catch(() => {})
    console.log('  ✓ ticked radio')
  } else {
    // fallback: click the "Home" card title
    await page.getByText(/^Home$/).first().click({ timeout: 4000, force: true }).catch(() => console.log('  ✗ radio/Home'))
  }
  await page.waitForTimeout(1500)
  console.log('→ Proceed (address)')
  await page.getByRole('button', { name: /^proceed/i }).first().click({ timeout: 5000, force: true }).catch(() => console.log('  ✗ proceed'))
  await page.waitForTimeout(4500)
  await shot(page, '7-after-address')

  // Slot step — should now be active; click it / it may auto-expand.
  console.log('\n→ open Slot')
  await page.getByText(/^slot$|select.*slot|choose.*slot|pick.*slot/i).first().click({ timeout: 4000, force: true }).catch(() => console.log('  (slot may auto-open)'))
  await page.waitForTimeout(4500)
  await shot(page, '8-slots')
  console.log(`  final controls: ${[...new Set(await ctrls(page))].slice(0, 24).join(' | ')}`)
  console.log(`\nFINAL url=${page.url()}  — STOPPED before payment`)
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
