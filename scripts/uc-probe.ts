/**
 * Urban Company recon probe (H1). Headless, reuses Blinkit's CF-beating
 * engine-backed identity (launchIdentity) as the TLS vehicle.
 *
 * Goals (DESIGN.md §14.1):
 *   - does headless Chromium pass UC's Cloudflare? (main-doc status + cf-ray)
 *   - discover the category URL structure from the Bangalore homepage
 *   - drill into cleaning / deep-cleaning and CAPTURE the catalog API calls
 *     (method + URL + response top-level keys) — filtering out analytics noise
 *
 * Run: npx tsx scripts/uc-probe.ts   (headful debug: UC_HEADLESS=0)
 */
import { writeFileSync } from 'node:fs'
import type { BrowserContext, Response } from 'playwright'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

const HEADLESS = process.env.UC_HEADLESS !== '0'
const NOISE = /google|gstatic|doubleclick|facebook|clarity|mixpanel|segment|sentry|hotjar|branch\.io|analytics|collect|gtm|font|\.(png|jpg|jpeg|webp|svg|gif|css|woff2?|ico)(\?|$)/i

interface Hit {
  method: string
  url: string
  status: number
  ctype: string
  topKeys?: string[]
  note?: string
}

function looksInteresting(url: string, ctype: string): boolean {
  if (NOISE.test(url)) return false
  if (/\/api\/|_next\/data|graphql|catalog|service|price|availab|slot|layout/i.test(url)) return true
  return ctype.includes('application/json')
}

async function capture(ctx: BrowserContext, hits: Map<string, Hit>) {
  ctx.on('response', async (res: Response) => {
    try {
      const req = res.request()
      const url = res.url()
      const ctype = (res.headers()['content-type'] ?? '').toLowerCase()
      if (!looksInteresting(url, ctype)) return
      const key = `${req.method()} ${url.split('?')[0]}`
      if (hits.has(key)) return
      const hit: Hit = { method: req.method(), url, status: res.status(), ctype }
      if (ctype.includes('application/json')) {
        try {
          const body = await res.json()
          hit.topKeys = Array.isArray(body) ? [`[array len ${body.length}]`] : Object.keys(body).slice(0, 25)
        } catch {
          hit.note = 'json parse failed'
        }
      }
      hits.set(key, hit)
    } catch {
      /* response gone */
    }
  })
}

function report(label: string, hits: Map<string, Hit>) {
  console.log(`\n===== API CALLS during: ${label}  (${hits.size}) =====`)
  for (const h of hits.values()) {
    console.log(`\n  ${h.method} ${h.status}  ${h.url.slice(0, 160)}`)
    if (h.topKeys) console.log(`     topKeys: ${h.topKeys.join(', ')}`)
    if (h.note) console.log(`     note: ${h.note}`)
  }
}

async function main() {
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: HEADLESS })
  const page = await ctx.newPage()

  // ---- Phase A: load Bangalore homepage, check CF, discover categories ----
  const homeHits = new Map<string, Hit>()
  await capture(ctx, homeHits)
  const resp = await page.goto('https://www.urbancompany.com/bangalore', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const h = resp?.headers() ?? {}
  console.log('===== MAIN DOC =====')
  console.log(`  status: ${resp?.status()}`)
  console.log(`  server: ${h.server}   cf-ray: ${h['cf-ray']}   cf-cache: ${h['cf-cache-status']}`)
  console.log(`  final url: ${page.url()}`)
  await page.waitForTimeout(4000)

  // Category links (learn the URL structure). Grab hrefs mentioning cleaning.
  const links = await page
    .$$eval('a[href]', (as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? '').trim().slice(0, 40) })))
    .catch(() => [])
  const cleaningLinks = links.filter((l) => /clean/i.test(l.href) || /clean/i.test(l.text))
  const uniqCleaning = [...new Map(cleaningLinks.map((l) => [l.href, l])).values()].slice(0, 15)
  console.log(`\n===== CLEANING-RELATED LINKS (${uniqCleaning.length} of ${links.length} total anchors) =====`)
  for (const l of uniqCleaning) console.log(`  ${l.text.padEnd(40)}  ${l.href}`)
  report('Bangalore homepage load', homeHits)

  // ---- Phase B: drill into the first cleaning category ----
  const target = uniqCleaning.find((l) => /deep|home.?clean|full.?home/i.test(l.href + l.text)) ?? uniqCleaning[0]
  if (target) {
    console.log(`\n\n>>>>> Navigating into: ${target.text} — ${target.href}`)
    const catHits = new Map<string, Hit>()
    await capture(ctx, catHits)
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => console.log(`  nav failed: ${e.message}`))
    await page.waitForTimeout(5000)
    console.log(`  final url: ${page.url()}`)
    report(`category page (${target.text})`, catHits)
    // Persist a machine-readable dump for the teardown.
    writeFileSync(
      `${process.env.TMPDIR ?? '/tmp'}/uc-probe-dump.json`,
      JSON.stringify({ home: [...homeHits.values()], category: [...catHits.values()], target }, null, 2),
    )
    console.log(`\n(dump written to ${process.env.TMPDIR ?? '/tmp'}uc-probe-dump.json)`)
  } else {
    console.log('\n(no cleaning category link found to drill into — dumping page text head)')
    console.log((await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 600))
  }

  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
