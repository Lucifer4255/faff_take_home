/**
 * UC login capture (H4). Drives account icon → Login → phone → OTP, capturing
 * the send/verify endpoints, then saves the session to .data/uc-session.json
 * (gitignored). OTP is relayed via scratchpad/uc/otp.txt (this script polls it).
 *
 * Run: npx tsx scripts/uc-login-capture.ts <10-digit-phone>
 * Phone comes from argv (never hardcoded). Nothing is charged — login only.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Page, Response } from 'playwright'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

const OUT = 'scratchpad/uc'
const OTP_FILE = `${OUT}/otp.txt`
const phone = (process.argv[2] ?? '').replace(/\D/g, '').slice(-10)

const calls: Array<Record<string, unknown>> = []
let cn = 0

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/login-${name}.png` }).catch(() => {})
}

async function typeInto(page: Page, value: string, hint: RegExp): Promise<boolean> {
  // Prefer a visible input matching the hint; fall back to the first visible input.
  const inputs = page.locator('input')
  const count = await inputs.count().catch(() => 0)
  let target = -1
  for (let i = 0; i < count; i++) {
    const el = inputs.nth(i)
    if (!(await el.isVisible().catch(() => false))) continue
    const ph = (await el.getAttribute('placeholder').catch(() => '')) ?? ''
    const type = (await el.getAttribute('type').catch(() => '')) ?? ''
    if (hint.test(ph) || hint.test(type)) {
      target = i
      break
    }
    if (target === -1) target = i // remember first visible as fallback
  }
  if (target === -1) return false
  const el = inputs.nth(target)
  await el.click({ timeout: 4000 }).catch(() => {})
  await el.pressSequentially(value, { delay: 90 }).catch(() => {})
  return true
}

async function clickCta(page: Page, labels: string[]): Promise<string | null> {
  for (const t of labels) {
    const el = page.getByText(t, { exact: false }).first()
    if (await el.count().then((c) => c > 0).catch(() => false)) {
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 4000, force: true }).catch(() => {})
        return t
      }
    }
  }
  return null
}

async function main() {
  if (phone.length !== 10) {
    console.log('ERR: pass a 10-digit phone as argv[2]')
    process.exit(1)
  }
  mkdirSync(OUT, { recursive: true })
  mkdirSync('.data', { recursive: true })
  if (existsSync(OTP_FILE)) rmSync(OTP_FILE) // clear any stale code

  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: true })
  const page = await ctx.newPage()
  ctx.on('response', async (res: Response) => {
    const u = res.url()
    if (!/urbanclap\.com\/api\/v2\//.test(u)) return
    if (/log|monitor|metric|getconfig|newevent|pushLogs|sampleRate|discoveryScreen|discoverySearch|PersistentCartIcon|WidgetReloadStatus/i.test(u)) return
    const i = cn++
    let text = ''
    try {
      text = await res.text()
    } catch {
      /* */
    }
    writeFileSync(`${OUT}/login-call-${String(i).padStart(2, '0')}.json`, text || '(empty)')
    calls.push({ i, method: res.request().method(), url: u.split('?')[0], status: res.status(), reqBody: res.request().postData()?.slice(0, 200) })
    console.log(`  [call ${i}] ${res.request().method()} ${res.status()} ${u.replace('https://www.urbanclap.com/api/v2/', '…/').split('?')[0]}`)
  })

  console.log('→ loading UC Bangalore')
  await page.goto('https://www.urbancompany.com/bangalore', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4500)

  console.log('→ opening login (account icon → Login)')
  await page.mouse.click(1229, 42)
  await page.waitForTimeout(1500)
  await clickCta(page, ['Login', 'Log in', 'Sign in'])
  await page.waitForTimeout(2500)
  await shot(page, '1-phone')

  console.log(`→ entering phone ••••••${phone.slice(-4)}`)
  const typed = await typeInto(page, phone, /phone|mobile|number|tel/i)
  console.log(`  phone typed: ${typed}`)
  await page.waitForTimeout(500)
  const sendCta = await clickCta(page, ['Continue', 'Get OTP', 'Send OTP', 'Proceed', 'Next', 'Verify'])
  console.log(`  send-OTP CTA: ${sendCta}`)
  await page.waitForTimeout(3500)
  await shot(page, '2-otp-sent')

  console.log(`\n*** OTP SENT to ••••••${phone.slice(-4)} — waiting for code in ${OTP_FILE} (up to 200s) ***`)
  let code = ''
  for (let i = 0; i < 100 && !code; i++) {
    await page.waitForTimeout(2000)
    if (existsSync(OTP_FILE)) code = readFileSync(OTP_FILE, 'utf8').replace(/\D/g, '').slice(0, 6)
  }
  if (!code) {
    console.log('*** no OTP received in time — aborting ***')
    await shot(page, '3-timeout')
    await browser.close()
    process.exit(2)
  }
  console.log(`→ got OTP ${code.length} digits — entering`)
  // OTP field: often 4-6 boxes or one input. Type the whole code; RN inputs auto-advance.
  const otpTyped = await typeInto(page, code, /otp|code|verif/i)
  if (!otpTyped) {
    // fall back: type on the focused element
    await page.keyboard.type(code, { delay: 120 }).catch(() => {})
  }
  await page.waitForTimeout(1500)
  await clickCta(page, ['Verify', 'Continue', 'Submit', 'Proceed', 'Confirm'])
  await page.waitForTimeout(4000)
  await shot(page, '4-verified')

  // Logged-in signal: a session/token cookie, or the account icon no longer says "Login".
  const cookies = await ctx.cookies().catch(() => [])
  const tokenCookie = cookies.find((c) => /token|session|auth|uc_/i.test(c.name))
  await ctx.storageState({ path: '.data/uc-session.json' })
  writeFileSync(`${OUT}/_login-manifest.json`, JSON.stringify({ phoneMasked: `••••••${phone.slice(-4)}`, calls, tokenCookie: tokenCookie?.name }, null, 2))
  console.log(`\n===== login capture done. ${calls.length} api calls. token cookie: ${tokenCookie?.name ?? '(none obvious)'} =====`)
  console.log('session saved → .data/uc-session.json')
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
