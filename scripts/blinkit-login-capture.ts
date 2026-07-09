/**
 * LIVE login capture (B4). Opens a HEADFUL Blinkit login window on your screen;
 * YOU type your phone number + OTP in that window and complete login. Your number
 * and OTP never pass through here. The script:
 *   - sniffs the send-OTP / verify-OTP / cart endpoints (for the auth module),
 *   - polls until you're logged in, then saves the session (gitignored) for reuse,
 *   - dumps the captured endpoint shapes to scratchpad.
 *
 * Run:  npx tsx scripts/blinkit-login-capture.ts
 * Then complete login in the window that opens. It auto-detects success (≤3 min).
 */
import './preload'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { chromium } from 'playwright'

const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'
const AUTH_FILE = process.env.BLINKIT_AUTH_FILE ?? '.playwright/blinkit-auth.storageState.json'
const LAT = Number(process.env.BLINKIT_LAT ?? 12.9352)
const LON = Number(process.env.BLINKIT_LON ?? 77.6245)

async function main() {
  console.log('[1] opening a Blinkit login window on your screen…')
  const ctx = await chromium.launchPersistentContext(`${OUT}/../.playwright-auth`, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'en-IN',
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())

  // Capture the auth + cart endpoints (method, url, and request/response bodies).
  const captured: Array<{ method: string; url: string; reqBody?: string; status?: number; resBody?: string }> = []
  const watch = /login|otp|verify|account|auth|token|\/v5\/carts/i
  page.on('request', (r) => {
    if (watch.test(r.url()) && /blinkit\.com/.test(r.url())) {
      captured.push({ method: r.method(), url: r.url().split('?')[0], reqBody: r.postData() ?? undefined })
    }
  })
  page.on('response', async (r) => {
    if (watch.test(r.url()) && /blinkit\.com/.test(r.url())) {
      const rec = captured.find((c) => c.url === r.url().split('?')[0] && c.status === undefined)
      if (rec) {
        rec.status = r.status()
        rec.resBody = await r.text().then((t) => t.slice(0, 600)).catch(() => undefined)
      }
    }
  })

  await ctx.addCookies([
    { name: 'gr_1_lat', value: String(LAT), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_lon', value: String(LON), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_locality', value: '0', domain: '.blinkit.com', path: '/' },
  ])
  await page.goto('https://blinkit.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3500)

  // Open the login modal for convenience; you fill phone + OTP in the window.
  await page.getByText('Login', { exact: true }).first().click({ timeout: 4000 }).catch(() => {})
  console.log('\n>>> In the window: enter your mobile number → Continue → type the OTP → finish login.')
  console.log('    (your number/OTP stay in the browser — not sent anywhere here)\n[2] waiting for login (up to 3 min)…')

  // Poll for logged-in: the top-right "Login" link disappears once authenticated.
  let loggedIn = false
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(2000)
    const stillLoggedOut = await page
      .getByText('Login', { exact: true })
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false)
    if (!stillLoggedOut) {
      loggedIn = true
      break
    }
  }

  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/blinkit-auth-endpoints.json`, JSON.stringify(captured, null, 2))
  console.log(`[3] captured ${captured.length} auth/cart calls → scratchpad/blinkit-auth-endpoints.json`)
  for (const c of captured) console.log(`   ${c.method} ${c.url}  → ${c.status ?? '?'}`)

  if (loggedIn) {
    mkdirSync(dirname(AUTH_FILE), { recursive: true })
    await ctx.storageState({ path: AUTH_FILE })
    console.log(`\n[✓] logged in — session saved to ${AUTH_FILE} (gitignored). The adapter can reuse it.`)
  } else {
    console.log('\n[!] did not detect login within 3 min — re-run and complete login in the window.')
  }
  await page.waitForTimeout(1500)
  await ctx.close()
}
void main().catch((e) => {
  console.error('LOGIN CAPTURE FAILED:', e)
  process.exit(1)
})
