import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { JsonStore } from '@/core/store'
import { apiPost } from './client'

/**
 * Urban Company authenticated booking (Tier B, DESIGN §14). UC login is
 * CAPTCHA-walled, so we never script Turnstile or the OTP — and, per a live
 * failure, "never script" has to mean **zero Playwright control of the browser
 * during login**, not just "no scripted clicks." An earlier version had
 * Playwright *launch* the login browser (even headful, even with no scripted
 * input past the modal) and Turnstile still rejected it — Playwright keeps an
 * active CDP control channel to any browser it launches, for the whole
 * session, and that channel itself is a detectable signal independent of what
 * it's used for. The mechanism that's actually proven (scripts/uc-cdp-capture.ts):
 * the user launches their OWN real Chrome (one extra flag, no Playwright
 * involved) and logs in completely normally — Turnstile sees an ordinary
 * browser with nothing attached. `sendLoginCode` gives the launch command;
 * `verifyLoginCode` then `connectOverCDP`s — READ-ONLY, purely to lift the
 * resulting session cookie — after the human is already done. Captured into
 * `authStore` keyed by the app's `userId`, a real per-user Bearer token, then
 * injected into headless API calls afterward (Cloudflare cleared by our own
 * identity there; auth is orthogonal to that — see client.ts). Same per-user
 * token-injection shape as the Blinkit B4 adapter. `importFromSession` remains
 * as a lower-level path for the scratch capture scripts.
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

// Dedicated port, distinct from Chrome's common default (9222) so it won't
// collide with a debug session the user already has open for something else.
const CDP_PORT = 9235
const CDP_URL = `http://localhost:${CDP_PORT}`

/** A real Chrome, opened with just a debugging port so we can read cookies
 * from it afterward. `--user-data-dir` isolates it from the user's normal
 * profile so it doesn't fight an already-open Chrome; each login gets a fresh
 * one. Launched as a **plain OS process** (node's `child_process.spawn`, not
 * Playwright's `.launch()`) — that distinction is what actually matters: a
 * process with no CDP client attached looks identical to Turnstile whether a
 * human typed the command or something spawned it on their behalf. We only
 * ever *connect* to it later (verifyLoginCode), never drive it. */
function chromeBinary(): string {
  return process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome'
}
function chromeLaunchCommand(citySlug: string, profileDir: string): string {
  const bin = chromeBinary()
  const quoted = bin.includes(' ') ? `"${bin}"` : bin
  return `${quoted} --remote-debugging-port=${CDP_PORT} --user-data-dir=${profileDir} --new-window "https://www.urbancompany.com/${citySlug}"`
}

/** Try to launch the login Chrome ourselves (convenience); falls back to just
 * returning the command for the user to run if spawning fails (binary not
 * found, no display, etc.) — the flow works either way, this only saves a copy/paste. */
function trySpawnChrome(citySlug: string): { spawned: boolean; command: string } {
  const profileDir = `/tmp/uc-login-${Date.now()}`
  const command = chromeLaunchCommand(citySlug, profileDir)
  try {
    const child = spawn(chromeBinary(), ['--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, '--new-window', `https://www.urbancompany.com/${citySlug}`], {
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', () => {
      /* the caller only sees the synchronous spawn() throw; async ENOENT etc. just means the window never opens — instructions still cover the manual path */
    })
    child.unref()
    return { spawned: true, command }
  } catch {
    return { spawned: false, command }
  }
}

const pendingLogins = new Set<string>() // phone digits with a login in flight

/** Open the login Chrome for the user (plain OS process, not Playwright-driven
 * — see module doc). Login itself — phone, Turnstile, OTP — all happens with
 * zero automation attached; we only ever `spawn` the window, never touch it
 * again until `verifyLoginCode` connects read-only afterward. */
export async function sendLoginCode(phone: string, citySlug = 'bangalore'): Promise<{ ok: boolean; error?: string; instructions?: string }> {
  const digits = phone.replace(/\D/g, '').slice(-10)
  if (digits.length !== 10) return { ok: false, error: 'expected a 10-digit phone number' }
  pendingLogins.add(digits)
  const { spawned, command } = trySpawnChrome(citySlug)
  return {
    ok: true,
    instructions: spawned
      ? `Opened a Chrome window — log into Urban Company yourself in it (your phone, Turnstile, the OTP, all you, nothing automated). If it didn't appear, run this instead:\n\n  ${command}\n\nOnce you're logged in there, come back and say "done".`
      : `Open a terminal and run:\n\n  ${command}\n\nThen log into Urban Company yourself in that window — your phone, Turnstile, the OTP, all you, nothing automated. Once you're logged in there, come back and say "done".`,
  }
}

/** Connects (read-only) to the Chrome the user launched from `sendLoginCode`'s
 * instructions, purely to lift the session cookie left by their own login —
 * never to drive anything. `code` isn't used (there's no OTP to relay through
 * chat in this flow; kept for interface parity with `AdapterTools`). Captures
 * into `authStore` keyed by `userId`. */
export async function verifyLoginCode(userId: string, phone: string, _code: string): Promise<{ ok: boolean; error?: string }> {
  const digits = phone.replace(/\D/g, '').slice(-10)
  if (!pendingLogins.has(digits)) return { ok: false, error: 'no login in progress — start over' }

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 8000 })
  } catch (e) {
    return { ok: false, error: `couldn't reach a Chrome on port ${CDP_PORT} — is it still running with --remote-debugging-port=${CDP_PORT}? (${e instanceof Error ? e.message : String(e)})` }
  }

  try {
    for (const ctx of browser.contexts()) {
      const cookies = await ctx.cookies().catch(() => [])
      const token = cookies.find((c) => c.name === '_uc_user_token' && /urban(company|clap)\.com/.test(c.domain))?.value
      if (!token) continue
      const get = (n: string) => cookies.find((c) => c.name === n)?.value
      const name = get('_uc_user_name')
      authStore.set(userId, { token, ucUserId: get('_uc_user_id'), name: name ? decodeURIComponent(name) : undefined, savedAt: Date.now() })
      pendingLogins.delete(digits)
      return { ok: true }
    }
    return { ok: false, error: "not logged in yet in that window — finish there, then reply again (or say 'resend' for the command)" }
  } finally {
    await browser.close().catch(() => {}) // detaches the CDP session only — does not close the user's Chrome
  }
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
