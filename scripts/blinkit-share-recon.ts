/**
 * Recon the shareable-cart link (v1/assist/cart/share). The /v5/carts response
 * exposes a "share cart" toolbar action; a share link would load the items for
 * anyone who opens it — a real handoff (no login needed, unlike pushing to an
 * account cart which turned out to be device-scoped). Uses the saved token.
 *
 *   npx tsx scripts/blinkit-share-recon.ts
 */
import './preload'
import { readFileSync, writeFileSync } from 'node:fs'
import { apiCall, closeClient } from '../src/adapters/blinkit/client'

const OUT = '/private/tmp/claude-501/-Users-biley-work-projects-faff-take-home/16030d53-08a0-497a-bf7c-86825bcca866/scratchpad'
const AUTH_FILE = process.env.BLINKIT_AUTH_FILE ?? '.playwright/blinkit-auth.storageState.json'

function token(): string {
  const s = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as { cookies?: Array<{ name: string; value: string }> }
  const c = s.cookies?.find((x) => /accessToken/i.test(x.name) && x.value.length > 20)
  if (!c) throw new Error('no token in saved session')
  return decodeURIComponent(c.value)
}

// Walk a layout tree for any {url} that mentions "share".
// biome-ignore lint: recon walker over untyped layout JSON
function findShare(node: any, hits: any[] = []): any[] {
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (k === 'url' && typeof v === 'string' && /share/i.test(v)) hits.push({ url: v, node })
      if (v && typeof v === 'object') findShare(v, hits)
    }
  }
  return hits
}

async function main() {
  const tok = token()
  console.log('[1] ensure a cart exists (push one item)')
  await apiCall('/v5/carts', { method: 'POST', token: tok, body: JSON.stringify({ items: [{ product_id: '640519', quantity: 1 }], promo_codes: [''] }) })

  console.log('[2] read cart, locate the share action')
  const cart = await apiCall('/v5/carts', { method: 'POST', token: tok, body: JSON.stringify({ items: [], promo_codes: [''] }) })
  writeFileSync(`${OUT}/blinkit-cart-full.json`, cart.body)
  let shareHits: Array<{ url: string; node: unknown }> = []
  try {
    shareHits = findShare(JSON.parse(cart.body))
  } catch {
    /* ignore */
  }
  console.log(`   share-ish actions found: ${shareHits.length}`)
  for (const h of shareHits.slice(0, 5)) console.log('   -', h.url, '\n     node:', JSON.stringify(h.node).slice(0, 300))

  console.log('[3] call the share endpoint (try GET then POST)')
  for (const method of ['GET', 'POST']) {
    const res = await apiCall('/v1/assist/cart/share', { method, token: tok, body: method === 'POST' ? '{}' : undefined })
    console.log(`   ${method} /v1/assist/cart/share → HTTP ${res.status} len ${res.body.length}`)
    if (res.ok) {
      writeFileSync(`${OUT}/blinkit-share-${method}.json`, res.body)
      // surface any link-looking value in the response
      const links = [...res.body.matchAll(/https?:\/\/[^"'\\ ]+/g)].map((m) => m[0]).filter((u) => /blinkit|grofers|share|cart/i.test(u))
      console.log('     links:', [...new Set(links)].slice(0, 6).join('  |  ') || '(none obvious — see the dump)')
      console.log('     sample:', res.body.slice(0, 300))
      break
    }
  }
}
main()
  .catch((e) => {
    console.error('SHARE RECON FAILED:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeClient()
    process.exit(process.exitCode ?? 0)
  })
