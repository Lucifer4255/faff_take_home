/**
 * UC recon phase 2 (H1). Drive the SPA clicks (categories are not <a> tags) and
 * capture every urbanclap.com/api/v2 call — request POST body + full response —
 * so we can read the service/price/slot shapes offline.
 *
 * Flow: /bangalore → click "Cleaning & Pest Control" → click a deep-cleaning
 * service → try to reach the schedule/slot step. Dumps to scratchpad/uc/.
 *
 * Run: npx tsx scripts/uc-probe2.ts   (headful: UC_HEADLESS=0)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import type { BrowserContext, Page, Response } from 'playwright'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

const HEADLESS = process.env.UC_HEADLESS !== '0'
const OUT = 'scratchpad/uc'
const API = /urbanclap\.com\/api\/v2\//
const SKIP = /log|monitor|metric|getconfig|newevent|pushLogs|sampleRate|WidgetReloadStatus/i

let n = 0
const manifest: Array<{ i: number; method: string; url: string; status: number; reqBody?: string; topKeys?: string[]; phase: string }> = []
let phase = 'load'

async function capture(ctx: BrowserContext) {
  ctx.on('response', async (res: Response) => {
    try {
      const url = res.url()
      if (!API.test(url) || SKIP.test(url)) return
      const req = res.request()
      const i = n++
      let topKeys: string[] | undefined
      let bodyText = ''
      try {
        bodyText = await res.text()
        const j = JSON.parse(bodyText)
        topKeys = Array.isArray(j) ? [`[array ${j.length}]`] : Object.keys(j).slice(0, 30)
      } catch {
        /* non-json */
      }
      writeFileSync(`${OUT}/${String(i).padStart(2, '0')}.json`, bodyText || '(empty)')
      const reqBody = req.postData() ?? undefined
      manifest.push({ i, method: req.method(), url, status: res.status(), reqBody: reqBody?.slice(0, 300), topKeys, phase })
      console.log(`  [${i}] ${req.method()} ${res.status()} ${url.replace('https://www.urbanclap.com/api/v2/', '…/')}`)
      if (topKeys) console.log(`       topKeys: ${topKeys.join(', ')}`)
    } catch {
      /* gone */
    }
  })
}

async function clickText(page: Page, text: string): Promise<boolean> {
  const el = page.getByText(text, { exact: false }).first()
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 5000 })
    await el.click({ timeout: 5000 })
    return true
  } catch {
    return false
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: HEADLESS })
  const page = await ctx.newPage()
  await capture(ctx)

  await page.goto('https://www.urbanclap.com/bangalore', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)

  phase = 'click-cleaning'
  console.log('\n>>> clicking "Cleaning & Pest Control"')
  const ok = (await clickText(page, 'Cleaning & Pest Control')) || (await clickText(page, 'Cleaning'))
  console.log(`  clicked=${ok}  url=${page.url()}`)
  await page.waitForTimeout(5000)

  // On the category page, look for a deep-cleaning service tile.
  phase = 'click-deep-cleaning'
  console.log('\n>>> looking for a deep-cleaning service')
  for (const t of ['Full Home Deep Cleaning', 'Deep Cleaning', 'Home Deep Cleaning', 'Bathroom Cleaning']) {
    if (await clickText(page, t)) {
      console.log(`  clicked "${t}"  url=${page.url()}`)
      break
    }
  }
  await page.waitForTimeout(5000)

  // Try to progress toward a schedule/slot step.
  phase = 'toward-slot'
  console.log('\n>>> trying Add / Book / Schedule')
  for (const t of ['Add', 'Book Now', 'Proceed', 'Schedule', 'Select a slot', 'Continue']) {
    if (await clickText(page, t)) {
      console.log(`  clicked "${t}"`)
      await page.waitForTimeout(3500)
    }
  }
  await page.waitForTimeout(3000)

  writeFileSync(`${OUT}/_manifest.json`, JSON.stringify(manifest, null, 2))
  console.log(`\n===== ${manifest.length} api calls captured → ${OUT}/ (see _manifest.json) =====`)
  console.log(`  final url: ${page.url()}`)
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
