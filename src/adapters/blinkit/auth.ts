import { JsonStore } from '@/core/store'
import { apiCall } from './client'

/**
 * Blinkit account auth — PER USER, so many people can use the app without their
 * carts/accounts colliding. Each user logs in with their own phone (OTP) and we
 * store just their `access_token`, keyed by a stable userId from the client.
 * Cart writes go through the ONE shared CF-passing browser with that user's
 * token injected as a header (see client.apiCall) — no browser per user.
 *
 * Endpoints (⟨capture⟩'d live — scripts/blinkit-login-capture.ts, B4):
 *   POST /v2/accounts/                     form user_phone=<10d>        → sends OTP
 *   POST /v2/accounts/verify/phone/code/   form user_phone=&verify_code= → { access_token, user }
 *   POST /v5/carts   {items:[{product_id,quantity}],promo_codes:['']} + access_token header
 *
 * Tokens live in `.data/blinkit-auth.json` (gitignored). Plaintext is fine for a
 * demo; a real deploy would use an encrypted per-user secret store.
 */

interface AuthRecord {
  accessToken: string
  phoneMasked?: string
  savedAt: number
}
const tokens = new JsonStore<AuthRecord>('.data/blinkit-auth.json')

export function isLoggedIn(userId: string): boolean {
  return Boolean(tokens.get(userId)?.accessToken)
}
export function tokenFor(userId: string): string | undefined {
  return tokens.get(userId)?.accessToken
}
export function logout(userId: string): void {
  tokens.delete(userId)
}

function tenDigits(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10)
}

/** Send a login OTP to the user's phone. */
export async function sendOtp(phone: string): Promise<{ ok: boolean; error?: string }> {
  const digits = tenDigits(phone)
  if (digits.length !== 10) return { ok: false, error: 'Please give a 10-digit mobile number.' }
  const res = await apiCall('/v2/accounts/', { method: 'POST', contentType: 'form', body: `user_phone=${digits}` })
  return res.ok ? { ok: true } : { ok: false, error: `Couldn't send the OTP (HTTP ${res.status}).` }
}

/** Verify the OTP and store the user's access_token under their userId. */
export async function verifyOtp(userId: string, phone: string, otp: string): Promise<{ ok: boolean; error?: string }> {
  const digits = tenDigits(phone)
  const code = otp.replace(/\D/g, '')
  if (!code) return { ok: false, error: 'Please enter the OTP.' }
  const res = await apiCall('/v2/accounts/verify/phone/code/', {
    method: 'POST',
    contentType: 'form',
    body: `user_phone=${digits}&verify_code=${code}`,
  })
  if (!res.ok) return { ok: false, error: `That OTP didn't verify (HTTP ${res.status}). Try again.` }
  let token: string | undefined
  try {
    token = JSON.parse(res.body)?.access_token
  } catch {
    /* fall through */
  }
  if (!token) return { ok: false, error: 'Login response had no token — please retry.' }
  tokens.set(userId, { accessToken: token, phoneMasked: `••••••${digits.slice(-4)}`, savedAt: Date.now() })
  return { ok: true }
}

/** Write the user's cart to Blinkit under THEIR account, so blinkit.com/cart
 * shows it when they open the app logged in. Stops before payment. */
export async function pushCart(
  userId: string,
  lines: Array<{ id: string; qty: number }>,
): Promise<{ ok: boolean; cartCount?: number; error?: string; expired?: boolean }> {
  const token = tokenFor(userId)
  if (!token) return { ok: false, error: 'not logged in' }
  const body = JSON.stringify({ items: lines.map((l) => ({ product_id: l.id, quantity: l.qty })), promo_codes: [''] })
  const res = await apiCall('/v5/carts', { method: 'POST', token, body })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      logout(userId) // token expired/invalid → force a fresh login next time
      return { ok: false, expired: true, error: 'Your Blinkit login expired — please log in again.' }
    }
    return { ok: false, error: `Couldn't sync the cart (HTTP ${res.status}).` }
  }
  let cartCount: number | undefined
  try {
    cartCount = JSON.parse(res.body)?.user_profile_data?.cart_count
  } catch {
    /* ignore */
  }
  return { ok: true, cartCount }
}
