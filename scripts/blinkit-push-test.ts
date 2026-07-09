/**
 * Validate the multi-user cart write: through the CF-passing client browser,
 * POST /v5/carts with a user's access_token header → does the item land in THAT
 * user's cart? Uses the token from the saved session (no new OTP). Prints only
 * status + cart count (never the token).
 *
 *   npx tsx scripts/blinkit-push-test.ts
 */
import './preload'
import { readFileSync } from 'node:fs'
import { apiCall, closeClient } from '../src/adapters/blinkit/client'

const AUTH_FILE = process.env.BLINKIT_AUTH_FILE ?? '.playwright/blinkit-auth.storageState.json'

function extractToken(): string {
  const s = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as {
    cookies?: Array<{ name: string; value: string }>
    origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>
  }
  const c = s.cookies?.find((x) => /accessToken|access_token/i.test(x.name) && x.value.length > 20)
  if (c) return decodeURIComponent(c.value)
  for (const o of s.origins ?? []) {
    const ls = o.localStorage?.find((e) => /^auth$|accessToken/i.test(e.name) && e.value.length > 20)
    if (ls) return ls.value.replace(/^"|"$/g, '')
  }
  throw new Error('no token in saved session')
}

async function main() {
  const token = extractToken()
  console.log(`[0] token len ${token.length}, starts "${token.slice(0, 4)}…"`)

  console.log('[1] POST /v5/carts through the CF-passing client with the token header')
  const body = JSON.stringify({ items: [{ product_id: '640519', quantity: 1 }], promo_codes: [''] })
  const res = await apiCall('/v5/carts', { method: 'POST', token, body })
  let cartCount: unknown
  try {
    cartCount = JSON.parse(res.body)?.user_profile_data?.cart_count
  } catch {
    /* ignore */
  }
  console.log(`   → HTTP ${res.status} ok=${res.ok} cart_count=${JSON.stringify(cartCount)} len=${res.body.length}`)
  console.log(`   ${res.ok ? '✅ token-injection cart write WORKS via the shared browser' : `❌ HTTP ${res.status}: ${res.body.slice(0, 140)}`}`)
}
main()
  .catch((e) => {
    console.error('PUSH TEST FAILED:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeClient()
    process.exit(process.exitCode ?? 0)
  })
