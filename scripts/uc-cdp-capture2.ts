/**
 * Post-login session capture via connectOverCDP. Run AFTER the user has logged
 * into UC (human solved captcha + OTP) in the debug Chrome. Determines HOW UC
 * carries auth on API calls (cookie vs. header token), saves the session, and
 * reports so we can inject it into headless booking calls.
 *
 * Run: npx tsx scripts/uc-cdp-capture2.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const CDP = process.env.UC_CDP_URL || 'http://localhost:9222'
const AUTH_HEADER = /authorization|x-auth|x-access|token|bearer|x-user|x-customer/i
const AUTHY = /token|auth|session|jwt|tkn|access|bearer|uc_|customer|user/i

async function main() {
  mkdirSync('.data', { recursive: true })
  mkdirSync('scratchpad/uc', { recursive: true })
  const browser = await chromium.connectOverCDP(CDP, { timeout: 8000 }).catch((e) => {
    console.log(`✗ connect failed: ${(e as Error).message.split('\n')[0]}`)
    process.exit(2)
  })
  const ctx = browser.contexts()[0]
  if (!ctx) {
    console.log('no context')
    process.exit(2)
  }

  // Capture auth-relevant request headers + whether calls carry a real customerId.
  const authHeaders = new Map<string, string>()
  const customerIds = new Set<string>()
  ctx.on('request', (req) => {
    const u = req.url()
    if (!/urbanclap\.com\/api\/v2\//.test(u)) return
    const h = req.headers()
    for (const [k, v] of Object.entries(h)) if (AUTH_HEADER.test(k) && v) authHeaders.set(k, v.length > 40 ? `${v.slice(0, 40)}…(${v.length})` : v)
    const body = req.postData() ?? ''
    const m = body.match(/"(?:customerId|userId|customer_id)"\s*:\s*"([^"]+)"/)
    if (m?.[1]) customerIds.add(m[1])
  })

  // Find a UC page (or open one so cookies apply), then reload to fire API calls.
  let page = ctx.pages().find((p) => /urban(company|clap)\.com/.test(p.url()))
  if (!page) {
    page = await ctx.newPage()
    await page.goto('https://www.urbancompany.com/bangalore', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  }
  console.log(`UC page: ${page.url()}`)
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(6000)

  // Cookies + localStorage (post-login).
  const cookies = await ctx.cookies().catch(() => [])
  const ucCookies = cookies.filter((c) => /urban(company|clap)\.com/.test(c.domain))
  const authCookies = ucCookies.filter((c) => AUTHY.test(c.name) && c.value.length > 15)
  const store = await page.evaluate(() => {
    const dump = (s: Storage) => Object.keys(s).map((k) => [k, String(s.getItem(k))] as const)
    // biome-ignore lint: browser globals
    return { local: dump(window.localStorage), session: dump(window.sessionStorage) }
  }).catch(() => ({ local: [] as (readonly [string, string])[], session: [] as (readonly [string, string])[] }))
  const authLocal = store.local.filter(([k, v]) => AUTHY.test(k) && v.length > 15)

  console.log('\n===== AUTH MECHANISM =====')
  console.log(`logged-in? customerId seen on API calls: ${[...customerIds].join(', ') || 'NONE (not logged in yet?)'}`)
  console.log(`auth-ish request HEADERS: ${authHeaders.size ? [...authHeaders].map(([k, v]) => `${k}=${v}`).join(' | ') : '(none — auth is likely cookie-based)'}`)
  console.log(`auth-ish COOKIES (httpOnly-capable): ${authCookies.map((c) => `${c.name}@${c.domain}(len${c.value.length}${c.httpOnly ? ',httpOnly' : ''})`).join(', ') || '(none)'}`)
  console.log(`auth-ish localStorage: ${authLocal.map(([k, v]) => `${k}(len${v.length})`).join(', ') || '(none)'}`)

  await ctx.storageState({ path: '.data/uc-session.json' })
  writeFileSync('scratchpad/uc/_auth-report.json', JSON.stringify({
    customerIds: [...customerIds],
    authHeaderNames: [...authHeaders.keys()],
    authCookieNames: authCookies.map((c) => c.name),
    authLocalKeys: authLocal.map(([k]) => k),
    allLocalKeys: store.local.map(([k]) => k),
  }, null, 2))
  console.log('\n✓ session saved → .data/uc-session.json (report → scratchpad/uc/_auth-report.json)')
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
