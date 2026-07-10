/**
 * Does headless Firefox/WebKit (already in the identity pool) clear UC's
 * Cloudflare Turnstile on the LOGIN modal, the way a real non-CDP browser did
 * in a manual test? No phone number is submitted — Turnstile fires as soon as
 * the login modal opens, so we only need to open it and watch.
 *
 * Prior findings (TEARDOWN §2) only tested Chromium (bundled + real Chrome via
 * connectOverCDP) and both failed. Firefox/WebKit use non-CDP remote protocols
 * (Juggler / WebKit RDP), so Cloudflare's CDP-specific automation fingerprint
 * may not apply to them even headless.
 *
 * Run: npx tsx scripts/uc-turnstile-engine-probe.ts
 */
import { mkdirSync } from 'node:fs'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

const OUT = 'scratchpad/uc'

async function probe(identityId: string) {
  const identity = IDENTITIES.find((i) => i.id === identityId)
  if (!identity) throw new Error(`no identity ${identityId}`)
  console.log(`\n=== ${identity.id} (${identity.engine}), headless ===`)
  const { browser, ctx } = await launchIdentity(identity, { headless: true })
  const page = await ctx.newPage()
  try {
    await page.goto('https://www.urbancompany.com/kolkata', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(3000)
    // Account icon, top-right.
    await page.mouse.click(1229, 41)
    await page.waitForTimeout(1500)
    // Login button inside the checkout/account panel.
    const loginBtn = page.getByRole('button', { name: /^login$/i }).first()
    if (await loginBtn.count().catch(() => 0)) {
      await loginBtn.click().catch(() => {})
    } else {
      console.log('  no Login button found via account icon; trying nav link')
    }
    await page.waitForTimeout(2500)

    const hasTelInput = await page
      .locator('input[type="tel"], input[placeholder*="phone" i]')
      .first()
      .isVisible()
      .catch(() => false)
    const hasTurnstileFrame = await page
      .locator('iframe[src*="challenges.cloudflare.com"]')
      .count()
      .catch(() => 0)
    const bodyText = await page.locator('body').innerText().catch(() => '')
    const stuckOnVerifying = /verifying/i.test(bodyText)

    console.log(`  phone input visible: ${hasTelInput}`)
    console.log(`  turnstile iframe present: ${hasTurnstileFrame}`)
    console.log(`  "Verifying..." text still on page: ${stuckOnVerifying}`)
    await page.screenshot({ path: `${OUT}/turnstile-${identity.id}.png` }).catch(() => {})
  } finally {
    await browser.close()
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  for (const id of ['mac-firefox', 'mac-safari', 'mac-chrome']) {
    await probe(id).catch((e) => console.log(`  ERROR: ${e instanceof Error ? e.message : e}`))
  }
}
main()
