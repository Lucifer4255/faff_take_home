/** Continue from the stuck Kolkata modal: satisfy required add-on sections
 * (pick the free ₹0 options), enable Done, then push to the slot grid. */
import { chromium, type Page } from 'playwright'
const OUT = 'scratchpad/uc/ui'
async function shot(p: Page, n: string) {
  await p.screenshot({ path: `${OUT}/${n}.png` }).catch(() => {})
  console.log(`  📸 ${n} ${p.url().replace(/https:\/\/www\.urbancompany\.com/, '')}`)
}
async function tap(p: Page, re: RegExp, note: string): Promise<boolean> {
  for (const loc of [p.getByRole('button', { name: re }), p.getByText(re)]) {
    const el = loc.first()
    if (!(await el.count().then((c) => c > 0).catch(() => false))) continue
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
    if (await el.click({ timeout: 4000, force: true }).then(() => true).catch(() => false)) {
      console.log(`  ✓ ${note}`)
      return true
    }
  }
  console.log(`  ✗ ${note}`)
  return false
}
async function main() {
  const b = await chromium.connectOverCDP('http://localhost:9222', { timeout: 8000 })
  const p = b.contexts()[0].pages().find((x) => /urban/.test(x.url()))!
  console.log(`on ${p.url().replace(/https:\/\/www\.urbancompany\.com/, '')}`)

  // Satisfy required add-on sections: pick a free (₹0) option in each open one.
  console.log('\n→ pick free add-ons to enable Done')
  await tap(p, /cabinet exterior & stove/i, 'kitchen: Cabinet exterior & stove (₹0)')
  await p.waitForTimeout(800)
  await tap(p, /select sofa & mattress/i, 'expand sofa & mattress')
  await p.waitForTimeout(800)
  await tap(p, /dry vacuuming/i, 'sofa: Dry vacuuming')
  await p.waitForTimeout(1000)
  await shot(p, 'k1-addons')

  console.log('\n→ Done')
  await tap(p, /^Done/, 'Done')
  await p.waitForTimeout(3000)
  await shot(p, 'k2-added')

  console.log('\n→ cart → checkout')
  ;(await tap(p, /view cart/i, 'View Cart')) || (await tap(p, /checkout|proceed/i, 'Checkout'))
  await p.waitForTimeout(4000)
  await shot(p, 'k3-checkout')

  console.log('\n→ address (Kolkata, matches — no location dialog)')
  await tap(p, /select address/i, 'Select address')
  await p.waitForTimeout(3000)
  await p.locator('[role="radio"], input[type="radio"]').first().click({ timeout: 4000, force: true }).catch(() => {})
  await p.waitForTimeout(1000)
  await tap(p, /^proceed/i, 'Proceed')
  await p.waitForTimeout(5000)
  await shot(p, 'k4-slots')
  console.log(`\nFINAL ${p.url().replace(/https:\/\/www\.urbancompany\.com/, '')} — stopped before payment`)
  await b.close()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
