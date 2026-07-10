/** Quick: click the account icon, confirm a phone-login modal opens. No submit. */
import { mkdirSync } from 'node:fs'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

async function main() {
  mkdirSync('scratchpad/uc', { recursive: true })
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: true })
  const page = await ctx.newPage()
  await page.goto('https://www.urbancompany.com/bangalore', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)
  // Account icon (person) top-right.
  await page.mouse.click(1229, 42)
  await page.waitForTimeout(2500)
  const tel = await page.locator('input[type="tel"], input[placeholder*="phone" i], input[placeholder*="mobile" i], input[placeholder*="number" i]').count().catch(() => 0)
  const inputs = await page.$$eval('input', (els) => els.map((e) => ({ type: e.type, name: e.name, ph: e.placeholder })).filter((i) => i.type !== 'hidden')).catch(() => [])
  console.log(`tel inputs: ${tel}`)
  console.log('inputs:', JSON.stringify(inputs))
  await page.screenshot({ path: 'scratchpad/uc/login-open.png' }).catch(() => {})
  await browser.close()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
