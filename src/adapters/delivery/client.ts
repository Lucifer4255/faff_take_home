import { chromium } from 'playwright'
import type { BrowserContext, Page } from 'playwright'
import { buildDeepLink, parsePlace, parsePlaceSearch, parseProducts, parseStatus, type TripSnapshot, type UberLocation, type UberProduct } from './parse'

/**
 * Uber (P1) client — the transport is a real browser, same "browser as TLS
 * vehicle" pattern as blinkit/client.ts and homeservices/client.ts (NOT DOM
 * scraping; the data is JSON). Two surfaces, both captured live (see
 * scratchpad/uber-capture.md):
 *
 *  Tier A (guest, no login) — www.uber.com same-origin JSON:
 *    POST /api/pudoLocationSearch  free text → candidate places (Google-Places ids)
 *    POST /api/getPlaceDetails     place id → coordinates + address node
 *    → build the m.uber.com/go/product-selection deep link (booking-ready handoff).
 *
 *  Tier B (the "linked account" — logged in) — m.uber.com/go/graphql:
 *    Products    pickup/drop → ride options + fares (request_quote)
 *    TripRequest book the ride (confirm — EXECUTE gate, real money)
 *    GetStatus   trip/driver status (observe)
 *  Login is a one-time HUMAN step (Google/OTP); we never automate it (see auth.ts).
 *  A persistent browser profile IS the linked account — once the human signs in,
 *  the session lives in the userDataDir (gitignored) and every later call reuses it.
 *
 * Uber's edge is Cloudflare bot-management (__cf_bm) but a same-origin fetch from
 * inside a real logged-in page sails through (proven in capture). One persistent
 * context per userId, reused across calls; calls are serialized (good-citizen).
 */

// Headless once a session is warm; UBER_HEADFUL=1 forces headful (login/debug).
const HEADFUL = process.env.UBER_HEADFUL === '1'
// Per-user browser profile dir = the linked account. Gitignored (.data/).
const PROFILE_ROOT = process.env.UBER_PROFILE_DIR ?? '.data/uber-profiles'
// City-bias centre for pudoLocationSearch (results are ranked near this point).
// Kolkata default; override via UBER_LAT/UBER_LON or per call.
const BIAS_LAT = process.env.UBER_LAT ? Number(process.env.UBER_LAT) : 22.5726
const BIAS_LON = process.env.UBER_LON ? Number(process.env.UBER_LON) : 88.3639

interface Session {
  ctx: BrowserContext
  page: Page
}

// One persistent context per userId (single-flight via the Promise).
const sessions = new Map<string, Promise<Session>>()
// Which mode (headful?) each user's live context is in, so a login (needs
// headful) can relaunch a headless context and vice-versa.
const modes = new Map<string, boolean>()

function profileDir(userId: string): string {
  // Keep the dir filesystem-safe.
  return `${PROFILE_ROOT}/${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

/** Launch (once) the persistent context for this user and land on www.uber.com
 * so the Cloudflare cookie + any logged-in session cookies are in place. Passing
 * `headful` (for login) relaunches the context visibly if it isn't already. */
function ensureReady(userId: string, headful = false): Promise<Session> {
  const want = headful || HEADFUL
  const existing = sessions.get(userId)
  if (existing && modes.get(userId) === want) return existing
  const s = (async () => {
    // Only one context can hold a userDataDir at a time — close the old mode first.
    if (existing) await existing.then((sess) => sess.ctx.close()).catch(() => {})
    const ctx = await chromium.launchPersistentContext(profileDir(userId), {
      headless: !want,
      viewport: { width: 1280, height: 800 },
      // A real UA/locale — Uber's edge fingerprints the handshake; a stock
      // Chromium persistent context passes (proven), but keep India locale.
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    })
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto('https://www.uber.com/in/en/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
    await page.waitForTimeout(1500)
    return { ctx, page }
  })()
  sessions.set(userId, s)
  modes.set(userId, want)
  return s
}

// Serialize per-user calls (never hammer; keep the single page consistent).
const tails = new Map<string, Promise<unknown>>()
function serialize<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(userId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  tails.set(userId, run.catch(() => {}))
  return run
}

interface FetchResult {
  status: number
  ok: boolean
  body: string
}

/** Same-origin fetch from inside the Uber page (real TLS + cf cookie + session). */
async function pageFetch(page: Page, path: string, body: unknown): Promise<FetchResult> {
  return page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      return { status: res.status, ok: res.ok, body: await res.text() }
    },
    { path, body },
  )
}

/** Free text → candidate places (Tier A, guest). Ranked near the bias centre. */
export async function searchPlaces(userId: string, query: string, type: 'PICKUP' | 'DROPOFF', lat = BIAS_LAT, lon = BIAS_LON) {
  return serialize(userId, async () => {
    const { page } = await ensureReady(userId)
    const res = await pageFetch(page, '/api/pudoLocationSearch', { latitude: lat, longitude: lon, query, type })
    if (!res.ok) throw new Error(`pudoLocationSearch HTTP ${res.status}`)
    return parsePlaceSearch(JSON.parse(res.body))
  })
}

/** Place id → coordinates + address node (Tier A, guest). */
export async function placeDetails(userId: string, id: string, type: 'PICKUP' | 'DROPOFF', provider = 'google_places'): Promise<UberLocation | null> {
  return serialize(userId, async () => {
    const { page } = await ensureReady(userId)
    const res = await pageFetch(page, '/api/getPlaceDetails', { id, provider, type })
    if (!res.ok) throw new Error(`getPlaceDetails HTTP ${res.status}`)
    return parsePlace(JSON.parse(res.body))
  })
}

/** Resolve free text → a single best-match location with coordinates (search →
 * details on the top hit). null = nothing matched; callers must NOT guess a
 * fallback (a wrong pickup sends a real driver to the wrong place). */
export async function resolve(userId: string, text: string, type: 'PICKUP' | 'DROPOFF'): Promise<UberLocation | null> {
  const hits = await searchPlaces(userId, text, type)
  if (!hits.length) return null
  return placeDetails(userId, hits[0].id, type, hits[0].provider)
}

/** The booking-ready deep link for a resolved pickup/drop (Tier A handoff). */
export function deepLink(pickup: UberLocation, drop: UberLocation, vvid?: string): string {
  return buildDeepLink(pickup, drop, vvid)
}

/** Whether this user has a live logged-in Uber session in their profile. Cheap
 * check: getCurrentUser returns a non-null user only when authenticated. */
export async function isLoggedIn(userId: string): Promise<boolean> {
  return serialize(userId, async () => {
    const { page } = await ensureReady(userId)
    return pageIsLoggedIn(page)
  })
}

/**
 * Tier B — request_quote. Open the booking deep link in the (logged-in) page and
 * capture the `Products` GraphQL response as it fires, then parse ride options +
 * fares. Requires a logged-in session; returns [] with `loggedIn:false` otherwise.
 */
export async function quote(userId: string, pickup: UberLocation, drop: UberLocation): Promise<{ loggedIn: boolean; products: UberProduct[] }> {
  return serialize(userId, async () => {
    const { page } = await ensureReady(userId)
    if (!(await pageIsLoggedIn(page))) return { loggedIn: false, products: [] }

    // Capture the Products response body via a response listener (persisted
    // query → we read the response, not replay the request).
    let productsJson: unknown = null
    const onResp = async (resp: import('playwright').Response) => {
      if (!resp.url().includes('/go/graphql')) return
      try {
        const req = resp.request()
        const post = req.postData() ?? ''
        if (post.includes('"operationName":"Products"')) productsJson = await resp.json()
      } catch {
        /* ignore non-JSON / racing responses */
      }
    }
    page.on('response', onResp)
    try {
      await page.goto(deepLink(pickup, drop), { waitUntil: 'domcontentloaded', timeout: 60_000 })
      // Wait for the Products response (poll up to ~12s).
      for (let i = 0; i < 24 && !productsJson; i++) await page.waitForTimeout(500)
    } finally {
      page.off('response', onResp)
    }
    return { loggedIn: true, products: productsJson ? parseProducts(productsJson) : [] }
  })
}

/**
 * Open the user's OWN browser profile (headful) on Uber's sign-in page and leave
 * it for the human — the one-time "link my account" step. We NEVER type the
 * number, password, or OTP, and never drive Google's OAuth; the human signs in,
 * and the session persists in the profile dir (the linked account). Idempotent.
 */
export async function startLogin(userId: string): Promise<void> {
  return serialize(userId, async () => {
    const { page } = await ensureReady(userId, true) // force headful
    await page.goto('https://auth.uber.com/v2/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
  })
}

/**
 * Tier B — dispatch a real ride (confirm, post-gate: real money, a real driver).
 * Open the booking deep link (with the chosen vehicle) in the logged-in page and
 * click Uber's own "Request <product>" button — so Uber's client builds the exact
 * TripRequest (fare token + payment profile) itself. Best-effort trip id from the
 * TripRequest response. Deterministic single click — no LLM/DOM interpretation.
 */
export async function book(
  userId: string,
  pickup: UberLocation,
  drop: UberLocation,
  vvid: string,
): Promise<{ dispatched: boolean; tripId?: string; note: string }> {
  return serialize(userId, async () => {
    const { page } = await ensureReady(userId)
    if (!(await pageIsLoggedIn(page))) return { dispatched: false, note: 'not signed in' }
    let tripId: string | undefined
    let tripReq: { status: number; bodySlice: string } | undefined
    let reqError: string | undefined
    const onResp = async (resp: import('playwright').Response) => {
      if (!resp.url().includes('/go/graphql')) return
      try {
        const post = resp.request().postData() ?? ''
        if (post.includes('"operationName":"TripRequest"')) {
          const body = await resp.text()
          tripReq = { status: resp.status(), bodySlice: body.slice(0, 500) }
          const m = body.match(/"tripUUID"\s*:\s*"([0-9a-f-]{8,})"/i) || body.match(/"(?:tripId|uuid)"\s*:\s*"([0-9a-f-]{8,})"/i)
          if (m) tripId = m[1]
          // Surface Uber's own checkout error (e.g. payment) in plain language.
          const em = body.match(/"localizedErrorMessage"\s*:\s*"([^"]+)"/)
          const ec = body.match(/"errorCode"\s*:\s*"([^"]+)"/)
          if (em) reqError = em[1]
          else if (ec) reqError = ec[1]
        }
      } catch {
        /* ignore */
      }
    }
    page.on('response', onResp)
    try {
      await page.goto(deepLink(pickup, drop, vvid), { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(3500)

      // Inspect-only: open the payment selector and dump its options, then stop.
      if (process.env.UBER_INSPECT === '1') {
        const dump = async () =>
          [
            ...new Set(
              await page
                .evaluate(() => Array.from(document.querySelectorAll('button,[role=button],a,[data-baseweb],li')).map((e) => (e.textContent || '').trim()).filter((t) => t && t.length < 45))
                .catch(() => [] as string[]),
            ),
          ]
        await page.getByText(/Amazon Pay|UPI|Cash|Add payment|Card/i).first().click({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(1500)
        await page.screenshot({ path: '.data/uber-payments.png' }).catch(() => {})
        console.error('PAYMENT OPTIONS:', JSON.stringify(await dump()))
        page.off('response', onResp)
        return { dispatched: false, note: 'inspect only' }
      }

      const btn = page.getByRole('button', { name: /^(Request|Confirm|Choose)\b/i }).first()
      await btn.waitFor({ state: 'visible', timeout: 20_000 })
      const payToken = async () => {
        try {
          return JSON.parse((await btn.getAttribute('data-tracking-payload')) ?? '{}').paymentToken as string
        } catch {
          return undefined
        }
      }

      // Select the requested payment method if the default isn't usable (Amazon Pay
      // failed with INSUFFICIENT_BALANCE). The "Pay with" sheet is in an IFRAME
      // ("Uber - Payment Selection"), so drive it via frameLocator, then Save.
      const wantPay = process.env.UBER_PAYMENT ?? 'UPI Scan and Pay'
      const before = await payToken()
      if (before === 'amazon_pay' || process.env.UBER_PAYMENT) {
        try {
          await page.getByText(/Amazon Pay|Cash|Add payment/i).first().click({ timeout: 5000 })
          await page.waitForTimeout(1500)
          const pf = page.frameLocator('iframe[title="Uber - Payment Selection"]')
          await pf.getByText(new RegExp(wantPay.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first().click({ timeout: 6000 })
          await page.waitForTimeout(500)
          await pf.getByRole('button', { name: /^Save$/i }).first().click({ timeout: 6000 }).catch(() => {})
          await page.waitForTimeout(1500)
        } catch {
          await page.keyboard.press('Escape').catch(() => {}) // don't leave the sheet blocking Request
        }
      }

      // Guard: don't dispatch on a payment token known to fail.
      const after = await payToken()
      if (after === 'amazon_pay') {
        page.off('response', onResp)
        return { dispatched: false, note: `payment still Amazon Pay (couldn't switch to ${wantPay}) — set your default Uber payment to ${wantPay} or Cash in the app` }
      }

      const btnLabel = (await btn.textContent().catch(() => ''))?.trim()
      await btn.click()
      await page.waitForTimeout(1500)
      // A dispatch may need a second confirm sheet (payment/pickup). Only auto-click
      // it when explicitly enabled — otherwise we observe (screenshot) first.
      if (process.env.UBER_BOOK_CONFIRM2 === '1') {
        const confirm2 = page.getByRole('button', { name: /^(Confirm|Request|Yes|Continue)\b/i }).first()
        if (await confirm2.isVisible().catch(() => false)) {
          const l2 = (await confirm2.textContent().catch(() => ''))?.trim()
          if (l2 && l2 !== btnLabel) await confirm2.click().catch(() => {})
        }
      }
      // Dispatch confirmed when the app leaves product-selection or a trip id lands.
      for (let i = 0; i < 30 && !tripId && page.url().includes('product-selection'); i++) await page.waitForTimeout(500)
      await page.screenshot({ path: '.data/uber-book-after.png' }).catch(() => {})
    } finally {
      page.off('response', onResp)
    }
    const dispatched = Boolean(tripId) || !page.url().includes('product-selection')
    return {
      dispatched,
      tripId,
      reqError,
      note: dispatched
        ? 'trip requested'
        : reqError
          ? `Uber blocked the request: ${reqError}`
          : `request did not confirm${tripReq ? ` (TripRequest HTTP ${tripReq.status})` : ' (no TripRequest fired — button click may not have landed)'}`,
      tripReq,
    }
  })
}

/**
 * Observe — poll the active trip's `GetStatus` GraphQL for a window, returning a
 * snapshot per poll (status, driver, ETA, driver location). The trip view auto-
 * polls GetStatus; we ride those responses. Keeps the page on the live-trip view.
 * `onSnapshot` fires per new snapshot (for streaming into observe()/the CLI).
 */
export async function track(
  userId: string,
  opts: { durationMs?: number; intervalMs?: number; onSnapshot?: (s: TripSnapshot) => void } = {},
): Promise<TripSnapshot[]> {
  const duration = opts.durationMs ?? 30_000
  return serialize(userId, async () => {
    const { page } = await ensureReady(userId)
    const snaps: TripSnapshot[] = []
    const onResp = async (resp: import('playwright').Response) => {
      if (!resp.url().includes('/go/graphql')) return
      try {
        if (!((resp.request().postData() ?? '').includes('"operationName":"GetStatus"'))) return
        const snap = parseStatus(await resp.json(), Date.now())
        snaps.push(snap)
        opts.onSnapshot?.(snap)
      } catch {
        /* ignore racing/non-JSON */
      }
    }
    page.on('response', onResp)
    try {
      // m.uber.com/go/ redirects to the active-trip view when a ride is live.
      if (!page.url().includes('m.uber.com/go')) {
        await page.goto('https://m.uber.com/go/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
      }
      const end = Date.now() + duration
      while (Date.now() < end) await page.waitForTimeout(opts.intervalMs ?? 3000)
    } finally {
      page.off('response', onResp)
    }
    return snaps
  })
}

/**
 * One-shot diagnostic for a LIVE trip: capture full GetStatus bodies (to pin the
 * driver/vehicle/location fields), dump the trip-page controls + screenshot (to
 * find the real Cancel flow), and try clicking a Cancel control (capturing any
 * cancel mutation). Used once, with the human backstop-cancelling in-app.
 */
export async function diagnoseActiveTrip(userId: string, captureMs = 10_000) {
  return serialize(userId, async () => {
    const { page } = await ensureReady(userId)
    const statusBodies: string[] = []
    const cancelOps: Array<{ op: string; status: number; body: string }> = []
    const onResp = async (resp: import('playwright').Response) => {
      if (!resp.url().includes('/go/graphql')) return
      try {
        const op = ((resp.request().postData() ?? '').match(/"operationName":"(\w+)"/) || [])[1]
        if (op === 'GetStatus') statusBodies.push((await resp.text()).slice(0, 3500))
        else if (op && /cancel/i.test(op)) cancelOps.push({ op, status: resp.status(), body: (await resp.text()).slice(0, 300) })
      } catch {
        /* ignore */
      }
    }
    page.on('response', onResp)
    try {
      if (!page.url().includes('m.uber.com/go')) await page.goto('https://m.uber.com/go/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
      await page.waitForTimeout(captureMs)
      const controls = [
        ...new Set(
          await page
            .evaluate(() => Array.from(document.querySelectorAll('button,[role=button],a,[data-testid]')).map((e) => `${(e.textContent || '').trim().slice(0, 28)}|${e.getAttribute('data-testid') || ''}`).filter((s) => s.replace('|', '')))
            .catch(() => [] as string[]),
        ),
      ]
      await page.screenshot({ path: '.data/uber-trip.png' }).catch(() => {})
      // Attempt: click a Cancel control, then a confirm, capturing any cancel op.
      let cancelClicked = false
      const cand = page.getByRole('button', { name: /^Cancel/i }).first()
      if (await cand.isVisible().catch(() => false)) {
        await cand.click().catch(() => {})
        cancelClicked = true
        await page.waitForTimeout(1500)
        await page.getByRole('button', { name: /Cancel (ride|trip)|Yes|Confirm|Done/i }).first().click({ timeout: 4000 }).catch(() => {})
        await page.waitForTimeout(1500)
      }
      return { statusBodies, controls, cancelOps, cancelClicked }
    } finally {
      page.off('response', onResp)
    }
  })
}

/**
 * Cancel the active trip (the KILL PATH — DESIGN §5, wired/tested before any real
 * confirm). Best-effort: click Uber's own Cancel control + confirm. Cancelling
 * quickly after dispatch is free on Uber (no-driver-yet), which is why the real
 * dispatch is done once, last, on a short route with this path proven first.
 */
export async function cancel(userId: string): Promise<{ cancelled: boolean; finalStatus?: string; note: string }> {
  // Active-trip states — "cancelled" means clientStatus has LEFT this set (→ Looking).
  const ACTIVE = new Set(['Dispatching', 'WaitingForPickup', 'Matched', 'EnRoute', 'Arriving', 'Arrived', 'OnTrip'])
  return serialize(userId, async () => {
    const { page } = await ensureReady(userId)
    // Watch GetStatus so we can VERIFY the cancel took (never a false positive again).
    let latest: string | undefined
    const onResp = async (resp: import('playwright').Response) => {
      if (!resp.url().includes('/go/graphql')) return
      try {
        if ((resp.request().postData() ?? '').includes('"operationName":"GetStatus"')) {
          latest = (await resp.json())?.data?.status?.clientStatus
        }
      } catch {
        /* ignore */
      }
    }
    page.on('response', onResp)
    try {
      if (!page.url().includes('m.uber.com/go')) await page.goto('https://m.uber.com/go/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
      await page.waitForTimeout(1200)
      // Real flow (captured): "Cancel ride" → "Cancel trip?" dialog → "YES, CANCEL".
      await page.getByRole('button', { name: /Cancel ride|Cancel trip|^Cancel$/i }).first().click({ timeout: 8000 })
      await page.waitForTimeout(1200)
      await page.getByRole('button', { name: /YES,?\s*CANCEL/i }).first().click({ timeout: 6000 })
      // Verify via GetStatus: cancelled once clientStatus leaves the active set.
      let cancelled = false
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(2000)
        if (latest && !ACTIVE.has(latest)) {
          cancelled = true
          break
        }
      }
      return {
        cancelled,
        finalStatus: latest,
        note: cancelled ? `cancelled (status: ${latest})` : `clicked YES,CANCEL but status is still ${latest ?? 'unknown'} — verify in the Uber app`,
      }
    } catch (e) {
      return { cancelled: false, finalStatus: latest, note: `cancel failed (${e instanceof Error ? e.message : e}) — cancel in the Uber app` }
    } finally {
      page.off('response', onResp)
    }
  })
}

/** In-page login check (no serialize wrapper — called from already-serialized fns).
 * getCurrentUser is a www.uber.com endpoint and `fetch('/api/…')` is relative to
 * the page's CURRENT origin — after an OTP login the page can still be on
 * auth.uber.com, where the relative call misses. So ensure we're on www first. */
async function pageIsLoggedIn(page: Page): Promise<boolean> {
  try {
    if (!page.url().startsWith('https://www.uber.com/')) {
      await page.goto('https://www.uber.com/in/en/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
      await page.waitForTimeout(800)
    }
    const res = await pageFetch(page, '/api/getCurrentUser?localeCode=en', {})
    if (!res.ok) return false
    const j = JSON.parse(res.body) as { data?: { user?: unknown } }
    return Boolean(j.data?.user)
  } catch {
    return false
  }
}

/** Close a user's browser (scripts call this; the server keeps it warm). */
export async function closeClient(userId?: string): Promise<void> {
  const ids = userId ? [userId] : [...sessions.keys()]
  for (const id of ids) {
    const s = sessions.get(id)
    if (!s) continue
    sessions.delete(id)
    await s.then((sess) => sess.ctx.close()).catch(() => {})
  }
}
