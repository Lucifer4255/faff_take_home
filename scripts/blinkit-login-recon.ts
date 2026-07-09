/**
 * Recon the Blinkit login UI (B4) WITHOUT triggering an OTP: open the login
 * modal, dump its inputs/buttons + selectors, and log network calls. The actual
 * send-OTP / verify-OTP endpoints fire only on submit, so we capture those live
 * (with a real number) during the integration test — here we just learn the
 * modal's shape so the auth module can drive it.
 *
 *   npx tsx scripts/blinkit-login-recon.ts
 */
import './preload'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'

async function main() {
  const ctx = await chromium.launchPersistentContext(`${OUT}/../.playwright-login`, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'en-IN',
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  const calls: string[] = []
  page.on('request', (r) => {
    if (/blinkit\.com|grofers/.test(r.url()) && (r.resourceType() === 'xhr' || r.resourceType() === 'fetch')) {
      calls.push(`${r.method()} ${r.url().split('?')[0]}`)
    }
  })

  console.log('[1] set location (clears the blocking location modal), then open Login')
  await ctx.addCookies([
    { name: 'gr_1_lat', value: '12.9352', domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_lon', value: '77.6245', domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_locality', value: '0', domain: '.blinkit.com', path: '/' },
  ])
  await page.goto('https://blinkit.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)

  // Click the top-right "Login" link, then the phone/OTP modal should appear.
  const login = page.getByText('Login', { exact: true }).first()
  if (await login.isVisible({ timeout: 2500 }).catch(() => false)) {
    console.log('   click "Login"')
    await login.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(2500)
  } else {
    console.log('   "Login" link not visible — dumping controls anyway')
  }

  // Dump every visible input + button so we know how to drive the phone/OTP form.
  const controls = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter((i) => {
        const r = i.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      .map((i) => ({
        type: i.getAttribute('type'),
        name: i.getAttribute('name'),
        placeholder: i.getAttribute('placeholder'),
        inputmode: i.getAttribute('inputmode'),
        maxlength: i.getAttribute('maxlength'),
        id: i.id || undefined,
      }))
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((b) => {
        const r = b.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      .map((b) => (b.textContent || '').trim())
      .filter((t) => t.length > 0)
      .slice(0, 25)
    return { inputs, buttons }
  })
  console.log('[2] visible inputs:', JSON.stringify(controls.inputs, null, 1))
  console.log('    visible buttons:', JSON.stringify(controls.buttons))
  console.log('[3] XHR/fetch calls seen:', [...new Set(calls)].join('  |  '))

  mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: `${OUT}/blinkit-login-modal.png` }).catch(() => {})
  writeFileSync(`${OUT}/blinkit-login-recon.json`, JSON.stringify({ controls, calls: [...new Set(calls)] }, null, 2))
  console.log(`   wrote blinkit-login-modal.png + blinkit-login-recon.json`)
  await ctx.close()
}
void main().catch((e) => {
  console.error('LOGIN RECON FAILED:', e)
  process.exit(1)
})
