import { readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserContext, chromium, type Page } from 'playwright'

/**
 * Blinkit HTTP client — but the transport is a real Chromium page, not `fetch`.
 *
 * Why: Blinkit sits behind Cloudflare bot-management that fingerprints the
 * TLS/HTTP2 handshake (JA3/JA4). A plain node/curl request — even with every
 * captured header and cookie — gets a 403 challenge page (proven in B1). A real
 * browser sails through. So we launch one persistent Chromium context, let it
 * clear the Cloudflare challenge and hold the location, then issue Blinkit's own
 * JSON endpoints from *inside* the page via same-origin `fetch`. Still an API
 * client (JSON in, JSON out) — the browser is just the TLS vehicle (DESIGN.md
 * §7, §12.2). This is the documented anti-automation fallback, used surgically.
 *
 * One context per process, lazily started and reused (good-citizen: no parallel
 * hammering; a real User-Agent; cookies/challenge solved once).
 *
 * Location (DESIGN.md §12.3): Blinkit is location-first — no catalog until a
 * delivery location is set, and price/availability are per dark-store. By
 * default we take the **current location** Blinkit resolves from the connection
 * (its IP-based default, read back from /location/info so we know & can show
 * where we're ordering). An explicit lat/lon (env override or setLocation, e.g.
 * after geocoding the intent's address) pins a different store.
 */

// Endpoints (⟨capture⟩'d live — scripts/blinkit-*-probe.ts):
//   GET  /visibility?latitude=&longitude=            serviceability + current-loc default
//   GET  /location/info?lat=&lon=&is_pin_moved=false resolve coords → address + serviceable
//   POST /v1/layout/search?q=&search_type=...        catalog search (guest, no auth)

const HEADLESS = process.env.BLINKIT_HEADLESS === '1'
const USER_DATA_DIR = process.env.BLINKIT_PROFILE_DIR ?? '.playwright/blinkit'
// Optional explicit override; when unset we use Blinkit's current (IP) location.
const ENV_LAT = process.env.BLINKIT_LAT ? Number(process.env.BLINKIT_LAT) : undefined
const ENV_LON = process.env.BLINKIT_LON ? Number(process.env.BLINKIT_LON) : undefined

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

let ready: Promise<{ ctx: BrowserContext; page: Page }> | null = null
let sniffedHeaders: Record<string, string> | null = null

/** Chromium locks a persistent profile with a SingletonLock symlink →
 * "<hostname>-<pid>". If that pid is dead (a crashed / kill -9'd prior run) the
 * lock is stale and blocks launch — clear it. Only remove it when the owner is
 * provably gone on this host; never yank a lock a live browser still holds. */
function clearStaleLock(dir: string): void {
  try {
    const target = readlinkSync(join(dir, 'SingletonLock')) // "host.local-53917"
    const pid = Number(target.slice(target.lastIndexOf('-') + 1))
    if (!Number.isInteger(pid)) return
    try {
      process.kill(pid, 0) // owner alive → real lock, leave it be
      return
    } catch {
      /* ESRCH: owner is gone → stale lock, safe to clear below */
    }
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      rmSync(join(dir, f), { force: true })
    }
  } catch {
    /* no lock symlink / unreadable → nothing to clear */
  }
}

/** Launch the persistent context. Prefer the canonical profile (reuses the
 * Cloudflare clearance + any captured login). If it's genuinely held by another
 * live process, fall back to a private per-process profile so we still work
 * (fresh Cloudflare solve, no shared cookies) instead of hard-failing with a
 * cryptic lock error. */
async function launchContext(opts: Parameters<typeof chromium.launchPersistentContext>[1]): Promise<BrowserContext> {
  clearStaleLock(USER_DATA_DIR)
  try {
    return await chromium.launchPersistentContext(USER_DATA_DIR, opts)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/SingletonLock|ProcessSingleton|already (in use|running)|Failed to create/i.test(msg)) throw err
    const alt = `${USER_DATA_DIR}-${process.pid}`
    console.warn(`[blinkit] profile "${USER_DATA_DIR}" is held by another live process — using a private profile "${alt}" (fresh Cloudflare solve, no shared login).`)
    return chromium.launchPersistentContext(alt, opts)
  }
}
let ipDefaultCoords: { lat: number; lon: number } | null = null
let currentLocation: BlinkitLocation | null = null

/** Launch (once) a Chromium context that has passed Cloudflare, then resolve a
 * delivery location. Subsequent calls reuse it. Single-flight via `ready`. */
function ensureReady(): Promise<{ ctx: BrowserContext; page: Page }> {
  if (ready) return ready
  ready = (async () => {
    const ctx = await launchContext({
      headless: HEADLESS,
      viewport: { width: 1280, height: 900 },
      // Grant + set geolocation only when we have an explicit coordinate; with no
      // override we let Blinkit derive the *current* location from the connection.
      ...(ENV_LAT !== undefined && ENV_LON !== undefined
        ? { geolocation: { latitude: ENV_LAT, longitude: ENV_LON }, permissions: ['geolocation'] }
        : {}),
      locale: 'en-IN',
    })
    const page = ctx.pages()[0] ?? (await ctx.newPage())

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

    // Resolve the working location: explicit env override wins; otherwise the
    // current location Blinkit picked from the connection.
    const coords = ENV_LAT !== undefined && ENV_LON !== undefined
      ? { lat: ENV_LAT, lon: ENV_LON }
      : (ipDefaultCoords ?? { lat: 28.4133, lon: 77.0728 }) // last-resort default if the sniff missed
    await applyLocation(page, ctx, coords.lat, coords.lon)

    return { ctx, page }
  })()
  return ready
}

/** Pin a delivery location: confirm serviceability + resolve its address via
 * /location/info, and set the cookies the catalog is scoped by. */
async function applyLocation(page: Page, ctx: BrowserContext, lat: number, lon: number): Promise<void> {
  await ctx.addCookies([
    { name: 'gr_1_lat', value: String(lat), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_lon', value: String(lon), domain: '.blinkit.com', path: '/' },
    { name: 'gr_1_locality', value: '0', domain: '.blinkit.com', path: '/' },
  ])
  let info: LocationInfo = { is_serviceable: false }
  try {
    const res = await page.evaluate(async ({ lat, lon }) => {
      const r = await fetch(`/location/info?lat=${lat}&lon=${lon}&is_pin_moved=false`, {
        headers: { 'content-type': 'application/json' },
      })
      return { ok: r.ok, body: await r.text() }
    }, { lat, lon })
    if (res.ok) info = JSON.parse(res.body) as LocationInfo
  } catch {
    /* keep serviceable=false; search may still work off cookies */
  }
  currentLocation = {
    lat,
    lon,
    serviceable: Boolean(info.is_serviceable),
    address: info.display_address?.address_line ?? info.location_info?.formatted_address,
    city: info.city ?? info.location_info?.city,
  }
}

interface LocationInfo {
  is_serviceable?: boolean
  city?: string
  display_address?: { address_line?: string }
  location_info?: { formatted_address?: string; city?: string }
}

/** Headers for our API calls: sniffed live set (preferred) + the active
 * location, or the static fallback + location. */
function apiHeaders(): Record<string, string> {
  const base = sniffedHeaders ? { ...sniffedHeaders } : { ...STATIC_HEADERS }
  for (const k of ['content-length', 'referer', 'user-agent', 'accept-encoding']) delete base[k]
  const loc = currentLocation
  return {
    ...base,
    'content-type': 'application/json',
    ...(loc ? { lat: String(loc.lat), lon: String(loc.lon) } : {}),
  }
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

/** Override the delivery location (e.g. after geocoding the intent's address).
 * Returns the resolved location so the caller can confirm serviceability. */
export async function setLocation(lat: number, lon: number): Promise<BlinkitLocation> {
  const { page, ctx } = await ensureReady()
  await applyLocation(page, ctx, lat, lon)
  // biome-ignore lint: currentLocation is set by applyLocation above
  return currentLocation!
}

/** The delivery location currently in effect (current/IP by default). */
export async function getLocation(): Promise<BlinkitLocation> {
  await ensureReady()
  // biome-ignore lint: ensureReady always resolves a location
  return currentLocation!
}

/** Raw Blinkit catalog search → the layout JSON (parsed by parse.ts). Guest, no
 * auth (B1: search works without login). Throws on a non-200 so the adapter can
 * surface a clean error to the agent. */
export async function searchRaw(query: string): Promise<unknown> {
  const path = `/v1/layout/search?q=${encodeURIComponent(query)}&search_type=type_to_search`
  const res = await pageFetch(path, { method: 'POST', headers: apiHeaders(), body: '{}' })
  if (!res.ok) {
    throw new Error(`Blinkit search HTTP ${res.status} for "${query}"${res.status === 403 ? ' (Cloudflare challenge — browser context may need a fresh navigate)' : ''}`)
  }
  try {
    return JSON.parse(res.body)
  } catch {
    throw new Error(`Blinkit search returned non-JSON (len ${res.body.length}) — likely a challenge/interstitial`)
  }
}

/** Shut the browser down (called from scripts; the server keeps it warm). */
export async function closeClient(): Promise<void> {
  if (!ready) return
  const { ctx } = await ready
  await ctx.close()
  ready = null
  currentLocation = null
  ipDefaultCoords = null
}
