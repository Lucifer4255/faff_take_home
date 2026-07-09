/**
 * Prove the guest shared-cart link renders the items: search a real product,
 * create a share link (no login), open it, and screenshot. If the page shows the
 * item, this is our handoff — build cart → share link → user opens + pays.
 *
 *   npx tsx scripts/blinkit-share-verify.ts
 */
import './preload'
import { chromium } from 'playwright'
import { apiCall, closeClient, searchRaw } from '../src/adapters/blinkit/client'
import { extractProducts } from '../src/adapters/blinkit/parse'

const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'

async function main() {
  console.log('[1] search a real product')
  const p = extractProducts(await searchRaw('milk')).find((x) => x.inStock)
  if (!p) throw new Error('no product')
  console.log(`   ${p.id} ${p.name} ₹${p.price} mrp=${p.mrp} img=${p.imageUrl ? 'yes' : 'no'}`)

  console.log('[2] create a guest shared cart')
  const body = JSON.stringify({
    total_items: 1,
    cart_value: p.price,
    show_share_cart_preview: false,
    items: [{ product_id: p.id, quantity: 1, mrp: p.mrp ?? p.price, name: p.name, image_url: p.imageUrl ?? '' }],
  })
  const res = await apiCall('/v1/assist/cart/share', { method: 'POST', body })
  const link = (() => {
    try {
      return JSON.parse(res.body)?.data?.deferred_deeplink as string
    } catch {
      return undefined
    }
  })()
  console.log(`   share HTTP ${res.status} → link: ${link}`)
  await closeClient()
  if (!link) throw new Error('no share link')

  console.log('[3] open the link (headful) + screenshot')
  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-IN' })
  const page = await ctx.newPage()
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => console.log('   nav note:', e.message))
  await page.waitForTimeout(6000)
  console.log('   landed at:', page.url())
  await page.screenshot({ path: `${OUT}/blinkit-shared-cart.png`, fullPage: false }).catch(() => {})
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '')
  console.log('   page text:', bodyText.replace(/\n+/g, ' | ').slice(0, 300))
  await page.waitForTimeout(1500)
  await browser.close()
}
void main().catch((e) => {
  console.error('SHARE VERIFY FAILED:', e)
  process.exit(1)
})
