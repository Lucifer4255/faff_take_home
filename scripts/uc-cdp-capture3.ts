/**
 * Capture the authenticated UC API surface from the logged-in debug browser:
 * dump every api/v2 call + response, flag which carry the Bearer token and which
 * responses contain the user's identity (so we get a verify endpoint) or
 * cart/booking data (the Tier-B endpoints). Run while logged in.
 *
 * Run: npx tsx scripts/uc-cdp-capture3.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const CDP = process.env.UC_CDP_URL || 'http://localhost:9222'
const PHONE = '7439245158'
const NOISE = /event-api|logging|monitor|metric|getconfig|newevent|pushLogs|sampleRate|WidgetReloadStatus/i

async function main() {
  mkdirSync('scratchpad/uc/auth', { recursive: true })
  const browser = await chromium.connectOverCDP(CDP, { timeout: 8000 })
  const ctx = browser.contexts()[0]
  const manifest: Array<Record<string, unknown>> = []
  let n = 0

  ctx.on('response', async (res) => {
    const u = res.url()
    if (!/urbanclap\.com\/api\/v2\//.test(u) || NOISE.test(u)) return
    const req = res.request()
    const i = n++
    const hasAuth = Boolean(req.headers().authorization)
    let text = ''
    try {
      text = await res.text()
    } catch {
      /* */
    }
    writeFileSync(`scratchpad/uc/auth/${String(i).padStart(2, '0')}.json`, text || '(empty)')
    const hasPhone = text.includes(PHONE)
    const short = u.replace('https://www.urbanclap.com/api/v2/', '…/').split('?')[0]
    manifest.push({ i, method: req.method(), url: short, status: res.status(), auth: hasAuth, userData: hasPhone })
    console.log(`  [${i}] ${req.method()} ${res.status()} auth=${hasAuth ? 'Y' : '-'} user=${hasPhone ? 'Y' : '-'} ${short}`)
  })

  const page = ctx.pages().find((p) => /urban(company|clap)\.com/.test(p.url())) ?? (await ctx.newPage())
  if (!/urban/.test(page.url())) await page.goto('https://www.urbancompany.com/bangalore', { waitUntil: 'domcontentloaded' })
  console.log(`reloading ${page.url()} to fire authenticated calls…`)
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(7000)

  writeFileSync('scratchpad/uc/auth/_manifest.json', JSON.stringify(manifest, null, 2))
  const authed = manifest.filter((m) => m.auth)
  const withUser = manifest.filter((m) => m.userData)
  console.log(`\n${manifest.length} api calls; ${authed.length} carried the Bearer token; ${withUser.length} returned user data`)
  console.log('user-data endpoints (verify candidates):', withUser.map((m) => m.url).join(', ') || '(none — try loading account/bookings page)')
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
