/**
 * UC login recon (H4 prep): find the login entry point + capture the login
 * modal's structure (phone input) and any endpoints, WITHOUT submitting a phone
 * (no SMS sent). Screenshots the modal so we can see selectors.
 *
 * Run: npx tsx scripts/uc-login-recon.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Response } from 'playwright'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

const OUT = 'scratchpad/uc'

async function main() {
  mkdirSync(OUT, { recursive: true })
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: true })
  const page = await ctx.newPage()
  const calls: string[] = []
  ctx.on('response', (r: Response) => {
    const u = r.url()
    if (/urbanclap\.com\/api\/v2\//.test(u) && /login|otp|auth|account|verify|token|sendCode|sign/i.test(u)) calls.push(`${r.status()} ${u.split('?')[0]}`)
  })

  await page.goto('https://www.urbancompany.com/bangalore', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)

  // Enumerate header/top-right controls to find the login trigger.
  const controls = await page
    .$$eval('button, [role="button"], a', (els) =>
      els
        .map((e) => {
          const r = (e as HTMLElement).getBoundingClientRect()
          return { text: (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        })
        .filter((c) => c.w > 0 && c.h > 0 && c.y < 120),
    )
    .catch(() => [])
  console.log('=== header controls (y<120) ===')
  for (const c of controls) console.log(`  "${c.text}"  @(${c.x},${c.y}) ${c.w}x${c.h}`)

  // Try to open login by common triggers.
  let opened = false
  for (const t of ['Login', 'Log in', 'Sign in', 'Account', 'My bookings']) {
    const el = page.getByText(t, { exact: false }).first()
    if (await el.count().then((c) => c > 0).catch(() => false)) {
      await el.click({ timeout: 4000, force: true }).catch(() => {})
      await page.waitForTimeout(2500)
      const tel = await page.locator('input[type="tel"], input[placeholder*="phone" i], input[placeholder*="mobile" i], input[placeholder*="number" i]').count().catch(() => 0)
      console.log(`\nclicked "${t}" → tel inputs on page: ${tel}`)
      if (tel > 0) {
        opened = true
        break
      }
    }
  }

  await page.screenshot({ path: `${OUT}/login-modal.png`, fullPage: false }).catch(() => {})
  // Dump any input fields visible.
  const inputs = await page
    .$$eval('input', (els) => els.map((e) => ({ type: e.type, name: e.name, placeholder: e.placeholder, id: e.id })).filter((i) => i.type !== 'hidden'))
    .catch(() => [])
  console.log('\n=== visible inputs ===')
  for (const i of inputs) console.log(`  type=${i.type} name=${i.name} ph="${i.placeholder}" id=${i.id}`)
  console.log(`\nlogin modal opened: ${opened}`)
  console.log(`auth-ish api calls: ${calls.length ? calls.join(' | ') : '(none)'}`)
  writeFileSync(`${OUT}/_login-recon.json`, JSON.stringify({ controls, inputs, calls, opened }, null, 2))

  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
