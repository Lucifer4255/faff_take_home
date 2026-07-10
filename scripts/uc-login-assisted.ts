/**
 * UC browser-ASSISTED login (H4). UC gates login behind a Cloudflare Turnstile
 * CAPTCHA, so login can't be fully programmatic. This opens a HEADFUL window;
 * the USER solves the Turnstile + enters the OTP; the script detects login,
 * saves the session to .data/uc-session.json (gitignored) for headless reuse.
 * (DESIGN §7: browser to clear login/OTP once, capture the session.)
 *
 * Run: npx tsx scripts/uc-login-assisted.ts <10-digit-phone>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Response } from 'playwright'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

const OUT = 'scratchpad/uc'
const phone = (process.argv[2] ?? '').replace(/\D/g, '').slice(-10)
const AUTHY = /token|auth|session|login|customer|jwt|tkn|uc_|xsrf|csrf/i

async function main() {
  if (phone.length !== 10) {
    console.log('ERR: pass a 10-digit phone as argv[2]')
    process.exit(1)
  }
  mkdirSync(OUT, { recursive: true })
  mkdirSync('.data', { recursive: true })
  // Use the REAL installed Google Chrome (channel:'chrome'), a genuine browser
  // build Turnstile trusts more than bundled Chromium. The USER solves the
  // CAPTCHA + OTP — we never script it.
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: false, channel: 'chrome' })
  const page = await ctx.newPage()

  const calls: Array<Record<string, unknown>> = []
  let cn = 0
  let tokenSeen = false
  ctx.on('response', async (res: Response) => {
    const u = res.url()
    if (!/urbanclap\.com\/api\/v2\//.test(u)) return
    if (/log|monitor|metric|getconfig|newevent|pushLogs|sampleRate|discoveryScreen|discoverySearch|PersistentCartIcon|WidgetReloadStatus|getHomescreenRequestState/i.test(u)) return
    const i = cn++
    let text = ''
    try {
      text = await res.text()
    } catch {
      /* */
    }
    // Strong positive login signal, independent of cookie naming.
    if (res.status() === 200 && (/"(access_?token|auth_?token|jwt|sessionToken)"/i.test(text) || /"isLoggedIn"\s*:\s*true/i.test(text) || /verify|otp|login|token/i.test(u))) tokenSeen = true
    writeFileSync(`${OUT}/login-call-${String(i).padStart(2, '0')}.json`, text || '(empty)')
    calls.push({ i, method: res.request().method(), url: u.split('?')[0], status: res.status(), reqBody: res.request().postData()?.slice(0, 160) })
    console.log(`  [call ${i}] ${res.request().method()} ${res.status()} ${u.replace('https://www.urbanclap.com/api/v2/', '…/').split('?')[0]}`)
  })
  const isTokenSeen = () => tokenSeen

  await page.goto('https://www.urbancompany.com/bangalore', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)
  await page.mouse.click(1229, 42)
  await page.waitForTimeout(1500)
  const login = page.getByText('Login', { exact: false }).first()
  if (await login.count().then((c) => c > 0).catch(() => false)) await login.click({ force: true }).catch(() => {})
  await page.waitForTimeout(2500)

  // Pre-fill the phone so the user only does Turnstile + OTP.
  const tel = page.locator('input').first()
  await tel.click({ timeout: 4000 }).catch(() => {})
  await tel.pressSequentially(phone, { delay: 80 }).catch(() => {})

  const baseline = new Set((await ctx.cookies().catch(() => [])).map((c) => c.name))

  console.log('\n==================================================================')
  console.log('  ACTION NEEDED IN THE BROWSER WINDOW:')
  console.log('   1) tick  "Verify you are human"  (Cloudflare)')
  console.log('   2) click Continue → enter the OTP texted to your phone')
  console.log('  I will detect login automatically and save the session.')
  console.log('==================================================================\n')

  let loggedIn = false
  let closed = false
  for (let i = 0; i < 150 && !loggedIn && !closed; i++) {
    try {
      await page.waitForTimeout(2000)
      const cookies = await ctx.cookies().catch(() => [])
      const fresh = cookies.filter((c) => !baseline.has(c.name) && c.value.length > 12)
      const authFresh = fresh.filter((c) => AUTHY.test(c.name))
      const modalGone = (await page.locator('text=Enter your phone number').count().catch(() => 0)) === 0
      // Detect via EITHER a token-bearing api response, OR (modal closed + a new
      // cookie appeared). Broader than the old auth-cookie-name-only check.
      if (isTokenSeen() || (modalGone && fresh.length > 0 && (authFresh.length > 0 || i > 6))) {
        loggedIn = true
        console.log(`✓ login detected (tokenSeen=${isTokenSeen()}, newCookies=${fresh.map((c) => c.name).join(',') || 'none'})`)
        await ctx.storageState({ path: '.data/uc-session.json' })
        console.log('  session saved immediately.')
      }
      if (i % 5 === 4) console.log(`  …waiting (${(i + 1) * 2}s) cookies=${cookies.length} newAuth=${authFresh.map((c) => c.name).join(',') || '-'}`)
    } catch {
      closed = true
      console.log('  (browser window was closed)')
    }
  }

  if (!loggedIn && !closed) {
    console.log('✗ login not detected in time. Saving state anyway for inspection.')
    await ctx.storageState({ path: '.data/uc-session.json' }).catch(() => {})
  }
  const cookieNames = (await ctx.cookies().catch(() => [])).map((c) => c.name)
  writeFileSync(`${OUT}/_login-manifest.json`, JSON.stringify({ loggedIn, phoneMasked: `••••••${phone.slice(-4)}`, calls, cookieNames }, null, 2))
  console.log(`\nsession → .data/uc-session.json  (loggedIn=${loggedIn}, ${calls.length} api calls captured)`)
  console.log('cookies:', cookieNames.join(', '))
  await browser.close().catch(() => {})
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
