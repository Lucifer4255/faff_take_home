import './preload'
import { chromium } from 'playwright'
const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'
async function main() {
  const ctx = await chromium.launchPersistentContext(`${OUT}/../.playwright-pdp`, { headless: false, locale: 'en-IN' })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  // Try the /prn/<slug>/prid/<id> pattern, and a slug-agnostic variant.
  const tries = [
    'https://blinkit.com/prn/amul-gold-milk/prid/179',
    'https://blinkit.com/prn/x/prid/179',
  ]
  for (const url of tries) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(3000)
    const finalUrl = page.url()
    const title = await page.title().catch(() => '')
    // Is a product name visible? (PDP shows an h1/product title)
    const hasProduct = await page.evaluate(() => document.body.innerText.toLowerCase().includes('amul') && document.body.innerText.toLowerCase().includes('milk')).catch(() => false)
    console.log(`try ${url}\n   → final=${finalUrl}\n   → title="${title}" | mentions Amul+milk=${hasProduct}`)
  }
  await ctx.close()
}
main().catch(e=>{console.error('FAIL',e);process.exitCode=1}).finally(()=>process.exit(process.exitCode??0))
