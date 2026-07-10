/**
 * Record the AUTHENTICATED booking flow from the logged-in debug Chrome via CDP.
 * Runs continuously (until killed) capturing every api/v2 call's request body +
 * response, so the user can click Add → size → cart → slot (stop before pay) and
 * we get the exact endpoint sequence + payloads to replay headless.
 *
 * Run (background): npx tsx scripts/uc-cdp-booking-capture.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const CDP = process.env.UC_CDP_URL || 'http://localhost:9222'
const OUT = 'scratchpad/uc/booking'
// Skip the calls we already understand + pure noise; keep cart/customization/slot/checkout.
const SKIP = /event-api|logging|monitor|metric|getconfig|newevent|pushLogs|sampleRate|WidgetReloadStatus|getDiscoveryScreen|discoverySearch|getPersistentCartIconData|getHomescreenRequestStateWidget|getRatingsAndReviews|initiateSeoJourney/i

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.connectOverCDP(CDP, { timeout: 8000 })
  const ctx = browser.contexts()[0]
  const manifest: Array<Record<string, unknown>> = []
  let n = 0
  console.log('recording authenticated booking calls… (click through the flow in Chrome; Ctrl-C or kill when done)')

  ctx.on('response', async (res) => {
    const u = res.url()
    if (!/urbanclap\.com\/api\/v2\//.test(u) || SKIP.test(u)) return
    const req = res.request()
    const i = n++
    let body = ''
    try {
      body = await res.text()
    } catch {
      /* */
    }
    writeFileSync(`${OUT}/${String(i).padStart(2, '0')}-res.json`, body || '(empty)')
    const reqBody = req.postData() ?? ''
    if (reqBody) writeFileSync(`${OUT}/${String(i).padStart(2, '0')}-req.json`, reqBody)
    const short = u.replace('https://www.urbanclap.com/api/v2/', '…/').split('?')[0]
    manifest.push({ i, method: req.method(), url: short, status: res.status(), auth: Boolean(req.headers().authorization), reqBody: reqBody.slice(0, 160) })
    writeFileSync(`${OUT}/_manifest.json`, JSON.stringify(manifest, null, 2))
    console.log(`  [${i}] ${req.method()} ${res.status()} auth=${req.headers().authorization ? 'Y' : '-'} ${short}`)
  })

  // Keep alive until the process is killed.
  await new Promise(() => {})
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
