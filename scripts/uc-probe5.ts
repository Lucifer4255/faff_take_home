/**
 * UC recon phase 5 (H1): reach the cleaning CATEGORY page and capture the
 * packages/pricing + (hopefully) availability/slot endpoints. Also note where
 * a login wall appears. Navigates candidate category URLs, dumps every non-noise
 * api/v2 response + its request body.
 *
 * Run: npx tsx scripts/uc-probe5.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import type { BrowserContext, Response } from 'playwright'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

const OUT = 'scratchpad/uc'
const API = /urbanclap\.com\/api\/v2\//
const SKIP = /log|monitor|metric|getconfig|newevent|pushLogs|sampleRate|WidgetReloadStatus|PersistentCartIcon/i
const CANDIDATES = [
  'https://www.urbancompany.com/bangalore-home-cleaning',
  'https://www.urbancompany.com/bangalore-full-home-cleaning',
  'https://www.urbancompany.com/bangalore-professional-home-cleaning',
]

let n = 0
const manifest: Array<Record<string, unknown>> = []

async function capture(ctx: BrowserContext, tag: string) {
  ctx.on('response', async (res: Response) => {
    try {
      const url = res.url()
      if (!API.test(url) || SKIP.test(url)) return
      const req = res.request()
      const i = n++
      let topKeys: string[] | undefined
      let text = ''
      try {
        text = await res.text()
        const j = JSON.parse(text)
        const d = j?.success?.data ?? j
        topKeys = d && typeof d === 'object' ? Object.keys(d).slice(0, 20) : undefined
      } catch {
        /* */
      }
      writeFileSync(`${OUT}/p5-${String(i).padStart(2, '0')}.json`, text || '(empty)')
      const short = url.replace('https://www.urbanclap.com/api/v2/', '…/').split('?')[0]
      manifest.push({ i, tag, method: req.method(), url: short, status: res.status(), reqBody: req.postData()?.slice(0, 200), topKeys })
      console.log(`  [${i}] ${req.method()} ${res.status()} ${short}${topKeys ? `  {${topKeys.join(',')}}` : ''}`)
    } catch {
      /* */
    }
  })
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: true })
  const page = await ctx.newPage()
  await capture(ctx, 'cat')

  for (const url of CANDIDATES) {
    console.log(`\n>>> ${url}`)
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => {
      console.log(`  nav err: ${e.message}`)
      return null
    })
    console.log(`  status=${resp?.status()}  final=${page.url()}`)
    await page.waitForTimeout(5000)
    if (resp && resp.status() < 400 && /clean/i.test(page.url())) break
  }

  // Try to progress toward slots: click Add on the first package, then any
  // Schedule/slot control — capturing whatever endpoints fire and where login hits.
  console.log('\n>>> attempting Add → schedule')
  for (const t of ['Add', 'Book Now', 'Proceed to checkout', 'Proceed', 'Schedule', 'Select slot', 'Continue', 'Login']) {
    const el = page.getByText(t, { exact: false }).first()
    if (await el.count().then((c) => c > 0).catch(() => false)) {
      const before = page.url()
      await el.click({ timeout: 4000 }).catch(() => {})
      await page.waitForTimeout(3000)
      const loginWall = /login|otp|sign|verify|phone/i.test(await page.content().catch(() => ''))
      console.log(`  "${t}" clicked  url=${page.url()}${page.url() !== before ? ' (navigated)' : ''}  loginHintOnPage=${loginWall}`)
    }
  }
  await page.waitForTimeout(2000)

  writeFileSync(`${OUT}/_p5-manifest.json`, JSON.stringify(manifest, null, 2))
  console.log(`\n===== ${manifest.length} calls → ${OUT}/p5-*.json =====  final url: ${page.url()}`)
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
