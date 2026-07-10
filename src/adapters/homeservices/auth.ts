import { existsSync, readFileSync } from 'node:fs'
import { JsonStore } from '@/core/store'
import { apiPost } from './client'

/**
 * Urban Company authenticated booking (Tier B, DESIGN §14). UC login is
 * CAPTCHA-walled, so we can't log a user in programmatically — instead the user
 * logs in ONCE in their own browser (solving Turnstile), and we capture the
 * resulting Bearer token (`_uc_user_token`) via connectOverCDP. That token is
 * then injected into headless API calls (Cloudflare cleared by our own identity),
 * letting us drive the booking flow AS the user — build a cart under their
 * account, reach the real slot grid, and STOP before payment. Same per-user
 * token-injection shape as the Blinkit B4 adapter.
 *
 * Auth token in `.data/uc-auth.json` (gitignored), keyed by our stable userId.
 */

// biome-ignore lint/suspicious/noExplicitAny: server-driven-UI + storageState shapes
type Any = any

interface UCAuth {
  token: string
  ucUserId?: string
  name?: string
  savedAt: number
}
const authStore = new JsonStore<UCAuth>('.data/uc-auth.json')

export function isLoggedIn(userId: string): boolean {
  return Boolean(authStore.get(userId)?.token)
}
export function authFor(userId: string): UCAuth | undefined {
  return authStore.get(userId)
}
export function logout(userId: string): void {
  authStore.delete(userId)
}

/** Import a session captured by the CDP login flow (storageState JSON) into the
 * per-user token store. This is how a user "logs in" to UC in our app: they do
 * the one-time human captcha+OTP in their browser, we capture, then import. */
export function importFromSession(userId: string, sessionPath = '.data/uc-session.json'): UCAuth | null {
  if (!existsSync(sessionPath)) return null
  const ss = JSON.parse(readFileSync(sessionPath, 'utf8'))
  const get = (n: string) => ss.cookies?.find((c: Any) => c.name === n)?.value
  const token = get('_uc_user_token')
  if (!token) return null
  const name = get('_uc_user_name')
  const auth: UCAuth = { token, ucUserId: get('_uc_user_id'), name: name ? decodeURIComponent(name) : undefined, savedAt: Date.now() }
  authStore.set(userId, auth)
  return auth
}

function findDeep(obj: Any, key: string): Any {
  if (!obj || typeof obj !== 'object') return undefined
  if (key in obj) return obj[key]
  for (const v of Object.values(obj)) {
    const r = findDeep(v, key)
    if (r !== undefined) return r
  }
  return undefined
}

export interface Draft {
  draftOrderId: string
  categoryKey: string
  cityKey: string
}

/** Start a booking journey under the user's account → mints a draftOrderId. */
export async function startBooking(opts: { categoryKey: string; cityKey: string; lat: number; lon: number; ucUserId: string; token: string }): Promise<Draft> {
  const { categoryKey, cityKey, lat, lon, ucUserId, token } = opts
  const { status, json } = await apiPost(
    'growth/customerJourney/initiateJourney',
    {
      city_key: null,
      userId: '',
      cityKey,
      countryKey: 'IND',
      dimensions: { categoryKey, cityKey, userId: ucUserId, coordinates: { lng: lon, lat }, source: 'customerApplications', useCase: 'multiCategoryCheckout' },
      deeplinkParams: { sectionId: categoryKey },
      dataPoints: { coordinates: { long: lon, lat } },
      triggerSource: { details: {}, type: 'category' },
      screenUrl: `/cart?city=${cityKey}&category=${categoryKey}`,
      utmContext: { utmCampaign: null, utmContent: null, utmMedium: null, utmSource: 'direct', utmTerm: null, userLanding: 'homepage', userNew: 0 },
    },
    token,
  )
  if (status !== 200) throw new Error(`initiateJourney HTTP ${status}`)
  // fjId is the clean draftOrderId; subflow `id` carries a `_listing_…` suffix.
  const fjId = findDeep((json as Any)?.success?.data?.dataStore?.fjMetaData, 'fjId') ?? findDeep(json, 'draftOrderId')
  const draftOrderId = fjId ? String(fjId).split('_')[0] : undefined
  if (!draftOrderId) throw new Error('initiateJourney: no draftOrderId in response')
  return { draftOrderId, categoryKey, cityKey }
}

/** Add a package (with its selected size/variants) to the draft — the cart write
 * that lands UNDER the user's account. `packages` is the catalog selection
 * (packageId + variant/optionKey ids from the package-detail screen). */
export async function addPackage(draftOrderId: string, packages: Any[], token: string): Promise<{ ok: boolean; status: number }> {
  const { status } = await apiPost('growth/customerJourney/updatePackageSelection', { city_key: null, draftOrderId, packages }, token)
  return { ok: status === 200, status }
}

/** Read the user's persistent cart (keyed by the auth token + cityKey, not the
 * draft) → number of packages currently in it. */
export async function getCart(cityKey: string, lat: number, lon: number, token: string): Promise<{ totalPackages: number; raw: unknown }> {
  const { json } = await apiPost('growth/customerJourney/getPackagesDataInPersistentCart', { city_key: null, dataPoints: { coordinates: { long: lon, lat } }, cityKey }, token)
  const totalPackages = Number(findDeep((json as Any)?.success?.data, 'totalPackages') ?? 0)
  return { totalPackages, raw: json }
}
