/**
 * Capture the user's UC session via connectOverCDP (human-in-the-loop login).
 *
 * The USER launches their own Chrome with a debugging port and logs into UC
 * themselves (solving the Cloudflare Turnstile + OTP as a real human — we never
 * touch the captcha). This script then ATTACHES to that already-logged-in
 * browser, reads the resulting session (cookies + localStorage), and saves it to
 * .data/uc-session.json (gitignored) for reuse in authenticated booking calls.
 *
 * Prereq — the user runs, in a terminal (quit normal Chrome first OR this uses a
 * separate profile so it won't clash):
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --remote-debugging-port=9222 --user-data-dir=/tmp/uc-chrome-profile
 * …then logs into urbancompany.com in that window.
 *
 * Run: npx tsx scripts/uc-cdp-capture.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const CDP = process.env.UC_CDP_URL || 'http://localhost:9222'
const AUTHY = /token|auth|session|jwt|tkn|login|secret|access|bearer|uc_|user/i

async function main() {
  mkdirSync('.data', { recursive: true })
  let browser
  try {
    browser = await chromium.connectOverCDP(CDP, { timeout: 8000 })
  } catch (e) {
    console.log(`✗ Could not connect to ${CDP} — is Chrome running with --remote-debugging-port=9222?`)
    console.log(`  (${(e as Error).message.split('\n')[0]})`)
    process.exit(2)
  }
  console.log(`✓ attached to ${CDP}`)

  const contexts = browser.contexts()
  console.log(`  contexts: ${contexts.length}`)
  let ucPageFound = false
  const report: Record<string, unknown> = {}

  for (const ctx of contexts) {
    // Cookies for UC domains.
    const cookies = await ctx.cookies().catch(() => [])
    const ucCookies = cookies.filter((c) => /urban(company|clap)\.com/.test(c.domain))
    const authCookies = ucCookies.filter((c) => AUTHY.test(c.name))
    if (ucCookies.length) {
      console.log(`\n  UC cookies (${ucCookies.length}): ${ucCookies.map((c) => c.name).join(', ')}`)
      console.log(`  auth-ish cookies: ${authCookies.map((c) => c.name).join(', ') || '(none by name — token may be in localStorage)'}`)
      report.ucCookieNames = ucCookies.map((c) => c.name)
      report.authCookieNames = authCookies.map((c) => c.name)
    }

    // localStorage / sessionStorage on any open UC page.
    for (const page of ctx.pages()) {
      const url = page.url()
      if (!/urban(company|clap)\.com/.test(url)) continue
      ucPageFound = true
      console.log(`\n  UC page: ${url}`)
      const store = await page
        .evaluate(() => {
          const dump = (s: Storage) => Object.fromEntries(Object.keys(s).map((k) => [k, String(s.getItem(k)).slice(0, 60)]))
          // biome-ignore lint: browser globals
          return { local: dump(window.localStorage), session: dump(window.sessionStorage) }
        })
        .catch(() => ({ local: {}, session: {} }))
      const lsKeys = Object.keys(store.local)
      const authKeys = lsKeys.filter((k) => AUTHY.test(k))
      console.log(`  localStorage keys (${lsKeys.length}): ${lsKeys.join(', ')}`)
      console.log(`  auth-ish localStorage: ${authKeys.join(', ') || '(none by name)'}`)
      report.localStorageKeys = lsKeys
      report.authLocalStorageKeys = authKeys
    }

    // Save full storage state (cookies + origins) for reuse.
    if (ucCookies.length) {
      await ctx.storageState({ path: '.data/uc-session.json' })
      console.log('\n  ✓ session saved → .data/uc-session.json')
    }
  }

  if (!ucPageFound) console.log('\n  ⚠ no open urbancompany.com tab found — open UC (logged in) in the debug Chrome, then re-run.')
  writeFileSync('scratchpad/uc/_cdp-report.json', JSON.stringify(report, null, 2))
  await browser.close() // detaches WITHOUT closing the user's Chrome (per Playwright docs)
  console.log('\n(detached — your Chrome stays open)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
