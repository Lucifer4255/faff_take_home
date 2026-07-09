/**
 * UC recon phase 6 (H1): drive category → Add → cart → checkout to find the
 * LOGIN WALL and (if reachable pre-login) the SLOT/availability endpoint.
 * Enumerates the real visible controls at each step (not blind text-guessing),
 * clicks the highest-priority next action, captures every api/v2 call, and stops
 * when a login screen or a slot/schedule screen appears.
 *
 * Run: npx tsx scripts/uc-probe6.ts   (headful: UC_HEADLESS=0)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import type { BrowserContext, Page, Response } from 'playwright'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

const OUT = 'scratchpad/uc'
const API = /urbanclap\.com\/api\/v2\//
const SKIP = /log|monitor|metric|getconfig|newevent|pushLogs|sampleRate|WidgetReloadStatus|PersistentCartIcon|getRatingsAndReviews/i
const INTEREST = /slot|availab|schedul|checkout|login|otp|verify|sendCode|sendOtp|cart|addToCart|address|payment|book/i
const START = 'https://www.urbancompany.com/bangalore-professional-home-cleaning'
// Priority order of CTAs to advance the funnel.
const NEXT_CTAS = ['Add', 'View Cart', 'View cart', 'Proceed to checkout', 'Proceed', 'Checkout', 'Continue', 'Select address', 'Add address', 'Select a slot', 'Select slot', 'Schedule', 'Next']

let n = 0
const manifest: Array<Record<string, unknown>> = []

function capture(ctx: BrowserContext, stepRef: { s: string }) {
  ctx.on('response', async (res: Response) => {
    try {
      const url = res.url()
      if (!API.test(url) || SKIP.test(url)) return
      const req = res.request()
      const i = n++
      let text = ''
      let topKeys: string[] | undefined
      try {
        text = await res.text()
        const j = JSON.parse(text)
        const d = j?.success?.data ?? j
        topKeys = d && typeof d === 'object' ? Object.keys(d).slice(0, 20) : undefined
      } catch {
        /* */
      }
      writeFileSync(`${OUT}/p6-${String(i).padStart(2, '0')}.json`, text || '(empty)')
      const short = url.replace('https://www.urbanclap.com/api/v2/', '…/').split('?')[0]
      const flag = INTEREST.test(short) ? '  <<< INTEREST' : ''
      manifest.push({ i, step: stepRef.s, method: req.method(), url: short, status: res.status(), reqBody: req.postData()?.slice(0, 220), topKeys })
      console.log(`    [${i}] ${req.method()} ${res.status()} ${short}${flag}`)
    } catch {
      /* */
    }
  })
}

/** Visible, clickable button-ish elements + their text. */
async function controls(page: Page): Promise<string[]> {
  return page
    .$$eval('button, [role="button"], a', (els) =>
      els
        .filter((e) => {
          const r = (e as HTMLElement).getBoundingClientRect()
          return r.width > 0 && r.height > 0 && (e as HTMLElement).offsetParent !== null
        })
        .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0 && t.length < 40),
    )
    .catch(() => [])
}

async function loginWall(page: Page): Promise<boolean> {
  const hasPhoneInput = await page.locator('input[type="tel"], input[name*="phone" i], input[placeholder*="phone" i], input[placeholder*="mobile" i]').count().catch(() => 0)
  if (hasPhoneInput > 0) return true
  const txt = (await page.evaluate(() => document.body.innerText).catch(() => '')).toLowerCase()
  return /enter (your )?(mobile|phone) number|verify.*otp|otp.*sent|log ?in to (continue|proceed|book)/.test(txt)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: true })
  const page = await ctx.newPage()
  const stepRef = { s: 'load' }
  capture(ctx, stepRef)

  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(5000)

  for (let step = 0; step < 9; step++) {
    if (await loginWall(page)) {
      console.log(`\n*** LOGIN WALL reached at step ${step} (url=${page.url()}) ***`)
      break
    }
    const ctas = await controls(page)
    const uniq = [...new Set(ctas)]
    stepRef.s = `step${step}`
    console.log(`\n>>> step ${step}  url=${page.url()}`)
    console.log(`    controls: ${uniq.slice(0, 22).join(' | ')}`)

    const pick = NEXT_CTAS.find((c) => uniq.some((t) => t.toLowerCase() === c.toLowerCase() || t.toLowerCase().startsWith(c.toLowerCase())))
    if (!pick) {
      console.log('    (no next CTA found — stopping)')
      break
    }
    console.log(`    clicking: "${pick}"`)
    const el = page.getByText(pick, { exact: false }).first()
    await el.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {})
    // UC is React-Native-Web: overlay divs intercept pointer events, so force
    // past the actionability check (we've already scrolled it into view).
    await el.click({ timeout: 5000, force: true }).catch((e) => console.log(`    click failed: ${String(e.message).split('\n')[0]}`))
    await page.waitForTimeout(4000)
    await page.screenshot({ path: `${OUT}/p6-step${step}.png` }).catch(() => {})
  }

  writeFileSync(`${OUT}/_p6-manifest.json`, JSON.stringify(manifest, null, 2))
  const interesting = manifest.filter((m) => INTEREST.test(String(m.url)))
  console.log(`\n===== ${manifest.length} calls; ${interesting.length} interesting =====`)
  for (const m of interesting) console.log(`  ${m.step}  ${m.method} ${m.status} ${m.url}`)
  console.log(`final url: ${page.url()}`)
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
