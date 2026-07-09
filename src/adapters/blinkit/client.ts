import type { Browser, BrowserContext, Page } from 'playwright'
import { JsonStore } from '@/core/store'
import { type Identity, IDENTITIES, launchIdentity, type ProxyCfg } from './identities'

/**
 * Blinkit HTTP client — the transport is a real browser page, not `fetch`.
 *
 * Why: Blinkit sits behind Cloudflare bot-management that fingerprints the
 * TLS/HTTP2 handshake AND runs a JS/environment challenge. A plain node/curl
 * request gets a 403 (proven in B1); a headless browser with the wrong
 * fingerprint also gets 403. So we drive a real browser from a rotating pool of
 * engine-backed identities (see identities.ts), navigate blinkit.com once to
 * clear the challenge, then issue Blinkit's own JSON endpoints from *inside* the
 * page via same-origin `fetch`. NOT DOM scraping — no locators, no clicking; the
 * browser is only the TLS/cookie vehicle, the data is JSON (DESIGN.md §7, §12.2).
 *
 * Fully headless (BLINKIT_HEADLESS=0 forces headful only for debugging). One
 * browser per process, reused across searches; on a Cloudflare 403 we rotate to
 * the next identity and retry, so one flagged fingerprint doesn't sink the run.
 *
 * Location (DESIGN.md §12.3): Blinkit is location-first — no catalog until a
 * delivery location is set, price/availability per dark-store. By default we take
 * the **current location** Blinkit resolves from the connection (its IP default,
 * read back from /location/info). An explicit lat/lon (env or setLocation) pins
 * a different store.
 */

// Endpoints (⟨capture⟩'d live — scripts/blinkit-*-probe.ts):
//   GET  /visibility?latitude=&longitude=            serviceability + current-loc default
//   GET  /location/info?lat=&lon=&is_pin_moved=false resolve coords → address + serviceable
//   POST /v1/layout/search?q=&search_type=...        catalog search (guest, no auth)

// Headless by default; BLINKIT_HEADLESS=0 forces headful (debugging only).
const HEADLESS = process.env.BLINKIT_HEADLESS !== '0'
const CHANNEL = process.env.BLINKIT_CHANNEL // chromium identities only: 'chrome' → real Google Chrome
// Optional explicit override; when unset we use Blinkit's current (IP) location.
const ENV_LAT = process.env.BLINKIT_LAT ? Number(process.env.BLINKIT_LAT) : undefined
const ENV_LON = process.env.BLINKIT_LON ? Number(process.env.BLINKIT_LON) : undefined

/** Optional egress proxy (BLINKIT_PROXY=http://[user:pass@]host:port). Not needed
 * to beat Cloudflare (a normal IP + real-engine fingerprint passes) — useful for
 * an India egress or to dodge IP rate-limits. */
function parseProxy(): ProxyCfg | undefined {
  const raw = process.env.BLINKIT_PROXY
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    return {
      server: `${u.protocol}//${u.host}`,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    }
  } catch {
    return { server: raw }
  }
}

// Fallback header set (⟨capture⟩'d 2026-07-09). auth_key is a static web-build
// key; we prefer whatever we sniff live and fall back to this if the sniff misses.
const STATIC_HEADERS: Record<string, string> = {
  app_client: 'consumer_web',
  platform: 'desktop_web',
  auth_key: 'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477',
  access_token: 'null',
}

export interface BlinkitLocation {
  lat: number
  lon: number
  serviceable: boolean
  address?: string
  city?: string
}

interface Session {
  browser: Browser
  ctx: BrowserContext
  page: Page
  identity: Identity
}

let ready: Promise<Session> | null = null
let sniffedHeaders: Record<string, string> | null = null
let ipDefaultCoords: { lat: number; lon: number } | null = null
let currentLocation: BlinkitLocation | null = null
// A delivery location captured by a real client (the web UI's browser
// geolocation, or a CLI --location flag) is PERSISTED here, so it survives a
// restart and is shared across the web + CLI: "get it from the app once, reuse
// it later" — the headless scraper has no GPS of its own.
const locationStore = new JsonStore<{ lat: number; lon: number }>('.data/blinkit-location.json')

// The delivery coords, PINNED once resolved. Precedence: env override > a
// persisted captured location > (at launch) the current/IP location. After the
// first resolve, every relaunch — incl. an identity rotation — re-applies THESE
// exact coords instead of re-deriving from a fresh IP sniff (which is
// timing-dependent and was leaving the store unpinned → "not serviceable").
let pinnedCoords: { lat: number; lon: number } | null =
  ENV_LAT !== undefined && ENV_LON !== undefined ? { lat: ENV_LAT, lon: ENV_LON } : (locationStore.get('pinned') ?? null)
// Which identity to launch next; randomized per process so restarts vary.
let identityIndex = Math.floor(Math.random() * IDENTITIES.length)

/** Launch (once) a browser from the current identity, pass Cloudflare, and
 * resolve a delivery location. Reused across calls; single-flight via `ready`. */
function ensureReady(): Promise<Session> {
  if (ready) return ready
  ready = (async () => {
    const identity = IDENTITIES[identityIndex % IDENTITIES.length]
    const geolocation =
      ENV_LAT !== undefined && ENV_LON !== undefined ? { latitude: ENV_LAT, longitude: ENV_LON } : undefined
    const { browser, ctx } = await launchIdentity(identity, { headless: HEADLESS, proxy: parseProxy(), geolocation, channel: CHANNEL })
    const page = await ctx.newPage()

    // Sniff the app's own traffic for (a) the live header set (auth_key etc.) and
    // (b) the current-location coords Blinkit resolves from IP on first load.
    page.on('request', (req) => {
      const url = req.url()
      if ((url.includes('/v1/layout/') || url.includes('/v5/carts')) && !sniffedHeaders) {
        const h = req.headers()
        if (h.auth_key) sniffedHeaders = h
      }
      if (url.includes('/visibility?') && !ipDefaultCoords) {
        const u = new URL(url)
        const lat = Number(u.searchParams.get('latitude'))
        const lon = Number(u.searchParams.get('longitude'))
        if (Number.isFinite(lat) && Number.isFinite(lon)) ipDefaultCoords = { lat, lon }
      }
    })

    await page.goto('https://blinkit.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(3500) // let Cloudflare + the first /visibility settle

    // Location is PINNED across identity rotations: reuse the already-resolved
    // coords if we have them; otherwise resolve once from current/IP (or env).
    const coords = pinnedCoords ?? ipDefaultCoords ?? { lat: 28.4133, lon: 77.0728 }
    await applyLocation(page, ctx, coords.lat, coords.lon)
    pinnedCoords = coords // lock in — the next relaunch re-applies exactly this

    return { browser, ctx, page, identity }
  })()
  return ready
}

/** Tear down the current browser and advance to the next identity, so the next
 * ensureReady() launches a fresh fingerprint. */
async function rotateIdentity(): Promise<void> {
  await closeClient()
  identityIndex = (identityIndex + 1) % IDENTITIES.length
}

/** Pin a delivery location: confirm serviceability + resolve its address via
 * /location/info, and set the cookies the catalog is scoped by. */
async function applyLocation(page: Page, ctx: BrowserContext, lat: number, lon: number): Promise<void> {
  await ctx.addCookies([
    { name: 'gr_1_lat', value: String(lat), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_lon', value: String(lon), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_locality', value: '0', domain: '.blinkit.com', path: '/' },
  ])
  // ACTIVATE the dark store for this session (what the web app does on location
  // set). Without this, the very first search races ahead of activation and
  // Blinkit 400s "location not serviceable". /location/info alone only resolves
  // an address; /visibility is what makes the store serviceable for search.
  await page
    .evaluate(async ({ lat, lon }) => {
      await fetch(`/visibility?latitude=${lat}&longitude=${lon}`, { headers: { 'content-type': 'application/json' } }).catch(() => {})
    }, { lat, lon })
    .catch(() => {})
  // Resolve serviceability/address, retrying once — a transient miss right after
  // a fresh navigation must not leave the store unpinned (the rotation bug).
  let info: LocationInfo = { is_serviceable: false }
  for (let attempt = 0; attempt < 2 && !info.is_serviceable; attempt++) {
    if (attempt > 0) await page.waitForTimeout(600)
    try {
      const res = await page.evaluate(
        async ({ lat, lon }) => {
          const r = await fetch(`/location/info?lat=${lat}&lon=${lon}&is_pin_moved=false`, {
            headers: { 'content-type': 'application/json' },
          })
          return { ok: r.ok, body: await r.text() }
        },
        { lat, lon },
      )
      if (res.ok) info = JSON.parse(res.body) as LocationInfo
    } catch {
      /* retry; coords are set below regardless so search headers stay correct */
    }
  }
  currentLocation = {
    lat,
    lon,
    serviceable: Boolean(info.is_serviceable),
    address: info.display_address?.address_line ?? info.location_info?.formatted_address,
    city: info.city ?? info.location_info?.city,
  }
  if (!currentLocation.serviceable) {
    console.warn(`[blinkit] /location/info did not confirm serviceability for ${lat},${lon} — search still uses these coords via cookies + headers`)
  }
}

interface LocationInfo {
  is_serviceable?: boolean
  city?: string
  coordinate?: { lat?: number; lon?: number }
  display_address?: { address_line?: string }
  location_info?: { formatted_address?: string; city?: string }
}

/** A place the user can pick when their address needs disambiguating. */
export interface AddressCandidate {
  label: string
  area?: string
  placeId: string
}

/** Address autocomplete (⟨capture⟩'d: GET /location/autoSuggest). Returns
 * candidate places for a free-text query, biased to the active location. Coords
 * come later via pinByPlaceId — this step only lists options. */
export async function suggestAddresses(text: string): Promise<AddressCandidate[]> {
  const { page } = await ensureReady()
  const near = currentLocation ?? pinnedCoords ?? { lat: 28.4133, lon: 77.0728 }
  const res = await page.evaluate(
    async ({ text, lat, lon }) => {
      const r = await fetch(`/location/autoSuggest?query=${encodeURIComponent(text)}&lat=${lat}&lng=${lon}&session_token=`, {
        headers: { 'content-type': 'application/json' },
      })
      return { ok: r.ok, body: await r.text() }
    },
    { text, lat: near.lat, lon: near.lon },
  )
  if (!res.ok) return []
  try {
    // biome-ignore lint: Blinkit layout JSON, walked loosely
    const data = JSON.parse(res.body) as any
    const suggestions: unknown[] = data?.ui_data?.suggestions ?? []
    return suggestions
      // biome-ignore lint: layout node
      .map((s: any) => ({ label: String(s?.title?.text ?? ''), area: s?.subtitle?.text as string | undefined, placeId: String(s?.meta?.place_id ?? '') }))
      .filter((c) => c.label && c.placeId)
  } catch {
    return []
  }
}

/** Resolve a chosen place_id → coords via /location/info, then PIN it (persisted,
 * rotation-safe). This is how a picked autocomplete suggestion becomes the store. */
export async function pinByPlaceId(placeId: string): Promise<BlinkitLocation> {
  const { page } = await ensureReady()
  const res = await page.evaluate(
    async ({ placeId }) => {
      const r = await fetch(`/location/info?place_id=${encodeURIComponent(placeId)}`, { headers: { 'content-type': 'application/json' } })
      return { ok: r.ok, status: r.status, body: await r.text() }
    },
    { placeId },
  )
  if (!res.ok) throw new Error(`Blinkit place lookup failed (HTTP ${res.status})`)
  const info = JSON.parse(res.body) as LocationInfo
  const lat = info.coordinate?.lat
  const lon = info.coordinate?.lon
  if (typeof lat !== 'number' || typeof lon !== 'number') throw new Error('place lookup returned no coordinates')
  return setLocation(lat, lon)
}

/** Headers for our API calls: sniffed live set (preferred) + the active location,
 * or the static fallback + location. */
function apiHeaders(): Record<string, string> {
  const base = sniffedHeaders ? { ...sniffedHeaders } : { ...STATIC_HEADERS }
  for (const k of ['content-length', 'referer', 'user-agent', 'accept-encoding']) delete base[k]
  const loc = currentLocation
  return { ...base, 'content-type': 'application/json', ...(loc ? { lat: String(loc.lat), lon: String(loc.lon) } : {}) }
}

interface FetchResult {
  status: number
  ok: boolean
  body: string
}

/** Issue a same-origin fetch from inside the Blinkit page (real TLS + cookies). */
async function pageFetch(path: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<FetchResult> {
  const { page } = await ensureReady()
  return page.evaluate(
    async ({ path, init }) => {
      const res = await fetch(path, init as RequestInit)
      return { status: res.status, ok: res.ok, body: await res.text() }
    },
    { path, init },
  )
}

// Serialize network calls (good-citizen: no parallel hammering) — also makes
// identity rotation safe, since we never tear the browser down mid-request.
let tail: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn)
  tail = run.catch(() => {})
  return run
}

function looksBlocked(res: FetchResult): boolean {
  // Cloudflare challenge: 403, or a big HTML interstitial instead of JSON.
  return res.status === 403 || res.status === 503 || (!res.ok && res.body.length > 5000)
}

/** Blinkit rejected the search because the store isn't active for this session
 * yet (the fresh-context activation race) — retryable by re-pinning. */
function isNotServiceable(res: FetchResult): boolean {
  return res.status === 400 && /serviceab/i.test(res.body)
}

/** A 200 with no product nodes — store lost its binding; retryable by re-pinning. */
function isEmptyOk(res: FetchResult): boolean {
  return res.ok && !res.body.includes('"product_id"')
}

/**
 * Make an arbitrary Blinkit API call through the CF-passing browser (guest
 * headers + optional per-user `token` as the access_token header — this is how
 * one shared browser serves many logged-in users without a browser each). On a
 * Cloudflare block it rotates identity and retries. Serialized with searches.
 * `contentType:'form'` sends a urlencoded body (the auth endpoints).
 */
export async function apiCall(
  path: string,
  opts: { method: string; body?: string; token?: string; contentType?: 'json' | 'form' },
): Promise<FetchResult> {
  return serialize(async () => {
    await ensureReady() // resolve the location first, so apiHeaders() carries lat/lon (required by /v5/carts)
    for (let attempt = 0; attempt < IDENTITIES.length; attempt++) {
      const headers = { ...apiHeaders() }
      if (opts.token) headers.access_token = opts.token
      if (opts.contentType === 'form') headers['content-type'] = 'application/x-www-form-urlencoded'
      const res = await pageFetch(path, { method: opts.method, headers, body: opts.body })
      if (!looksBlocked(res)) return res
      await rotateIdentity()
      console.warn(`[blinkit] ${path} blocked (HTTP ${res.status}) — rotated identity, retrying`)
    }
    throw new Error(`Blinkit ${path} blocked by Cloudflare across all identities`)
  })
}

export interface ShareItem {
  product_id: string
  quantity: number
  mrp: number
  name: string
  image_url: string
}

/**
 * Create a Blinkit SHARED CART (POST /v1/assist/cart/share) and return its
 * shareable deep link. GUEST — no login needed (⟨capture⟩'d). Opening the link
 * shows an "Items shared with you!" sheet with the items + Add-to-Cart, so the
 * user reviews and pays in Blinkit. This is the real checkout handoff (a plain
 * account-cart write is device-scoped and doesn't surface for the user).
 */
export async function createSharedCart(items: ShareItem[], cartValue: number): Promise<{ link?: string; sharedCartId?: string; error?: string }> {
  const total = items.reduce((n, i) => n + i.quantity, 0)
  const body = JSON.stringify({ total_items: total, cart_value: cartValue, show_share_cart_preview: false, items })
  const res = await apiCall('/v1/assist/cart/share', { method: 'POST', body })
  if (!res.ok) return { error: `share failed (HTTP ${res.status})` }
  try {
    const data = JSON.parse(res.body)?.data
    return { link: data?.deferred_deeplink, sharedCartId: data?.shared_cart_id }
  } catch {
    return { error: 'unexpected share response' }
  }
}

/** Set the delivery location from a real client (web-UI geolocation, CLI flag, or
 * a geocoded address). PINS it (rotations keep it) AND persists it so later web +
 * CLI runs reuse it without re-capturing. `persist:false` for an ephemeral pin. */
export async function setLocation(lat: number, lon: number, persist = true): Promise<BlinkitLocation> {
  pinnedCoords = { lat, lon }
  if (persist) locationStore.set('pinned', { lat, lon })
  const { page, ctx } = await ensureReady()
  await applyLocation(page, ctx, lat, lon)
  // biome-ignore lint: currentLocation is set by applyLocation above
  return currentLocation!
}

/** Whether a delivery location is already established (env override or a
 * previously captured+persisted location) — cheap, no browser launch. Lets the
 * harness skip asking the user when we already know where to deliver. */
export function hasPinnedLocation(): boolean {
  return pinnedCoords !== null
}

/** Forget any persisted/pinned location → next run falls back to current/IP. */
export function clearLocation(): void {
  pinnedCoords = ENV_LAT !== undefined && ENV_LON !== undefined ? { lat: ENV_LAT, lon: ENV_LON } : null
  locationStore.delete('pinned')
}

/** Force an identity rotation now (testing/ops): swap to the next identity while
 * keeping the pinned delivery location. Returns the new identity id. */
export async function rotateNow(): Promise<string> {
  await rotateIdentity()
  return (await ensureReady()).identity.id
}

/** The delivery location currently in effect (current/IP by default). */
export async function getLocation(): Promise<BlinkitLocation> {
  await ensureReady()
  // biome-ignore lint: ensureReady always resolves a location
  return currentLocation!
}

/** The identity currently driving the session (for logging / teardown). */
export async function currentIdentity(): Promise<string> {
  return (await ensureReady()).identity.id
}

/** Re-apply the pinned delivery location to the current context — the self-heal
 * when a store loses its location binding (search comes back empty). */
async function repinLocation(): Promise<void> {
  const c = pinnedCoords ?? (currentLocation ? { lat: currentLocation.lat, lon: currentLocation.lon } : null)
  if (!c) return
  const { page, ctx } = await ensureReady()
  await applyLocation(page, ctx, c.lat, c.lon)
}

/** Raw Blinkit catalog search → layout JSON (parsed by parse.ts). Guest, no auth.
 * Two layers of self-healing:
 *  - empty catalog (no product on a real query = the store lost its location
 *    binding) → re-pin the location and retry once, same identity;
 *  - Cloudflare block (403/503/interstitial) → rotate identity and retry.
 * Throws only if every identity is blocked, or on a genuine API error. */
export async function searchRaw(query: string): Promise<unknown> {
  const path = `/v1/layout/search?q=${encodeURIComponent(query)}&search_type=type_to_search`
  const doFetch = () => pageFetch(path, { method: 'POST', headers: apiHeaders(), body: '{}' })
  return serialize(async () => {
    for (let attempt = 0; attempt < IDENTITIES.length; attempt++) {
      let res = await doFetch()
      // Location not yet active (fresh context: the store activates a beat after
      // it's set, so the FIRST search 400s "not serviceable"), or a 200 with no
      // products (store lost its binding). Both self-heal: re-pin + retry, a few
      // times, same identity — this is a timing race, not a fingerprint block.
      for (let heal = 0; heal < 3 && (isNotServiceable(res) || isEmptyOk(res)); heal++) {
        console.warn(`[blinkit] "${query}" ${isNotServiceable(res) ? 'location not active yet' : 'empty'} — re-pinning (${pinnedCoords?.lat},${pinnedCoords?.lon}) & retrying (${heal + 1}/3)`)
        await repinLocation()
        res = await doFetch()
      }
      if (res.ok) {
        try {
          return JSON.parse(res.body)
        } catch {
          throw new Error(`Blinkit search returned non-JSON (len ${res.body.length}) for "${query}"`)
        }
      }
      if (!looksBlocked(res)) {
        throw new Error(`Blinkit search HTTP ${res.status} for "${query}": ${res.body.slice(0, 120)}`)
      }
      const from = (await ready)?.identity.id
      await rotateIdentity()
      const to = IDENTITIES[identityIndex % IDENTITIES.length].id
      console.warn(`[blinkit] search blocked (HTTP ${res.status}) on "${from}" — rotating to "${to}" and retrying`)
    }
    throw new Error(`Blinkit search blocked by Cloudflare across all ${IDENTITIES.length} identities for "${query}"`)
  })
}

/** Shut the browser down (scripts call this; the server keeps it warm). */
export async function closeClient(): Promise<void> {
  if (!ready) return
  const session = await ready.catch(() => null)
  await session?.browser.close().catch(() => {})
  ready = null
  currentLocation = null
  ipDefaultCoords = null
}
