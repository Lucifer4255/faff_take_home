import { type Browser, type BrowserContext, type Page } from 'playwright'
import { IDENTITIES, launchIdentity } from '../blinkit/identities'

/**
 * Urban Company web client (Home Services, P2). Like the Blinkit client, a real
 * Chromium (via launchIdentity) is only the **TLS/Cloudflare vehicle** — the data
 * is UC's internal JSON API on `www.urbanclap.com/api/v2/...`, issued from inside
 * the page (`page.evaluate(fetch)`) so real-Chrome TLS + CF cookies carry it.
 *
 * GUEST ONLY. Browse + search + category are no-auth (verified). LOGIN is walled
 * by a Cloudflare Turnstile CAPTCHA that rejects automated browsers, so the real
 * slot-grid + booking sit past a wall we don't cross — the adapter reaches a
 * booking-ready handoff (service + price + earliest availability + deep link) and
 * the human finishes (login + exact slot + pay) via the link. See the
 * uc-capture-findings memory.
 *
 * Endpoints (⟨capture⟩'d live — scripts/uc-probe*.ts):
 *   POST /api/v2/growth/search/discoverySearch            catalog search
 *   POST /api/v2/growth/customerJourney/initiateSeoJourney category page (earliest slot)
 */

const HEADLESS = process.env.UC_HEADLESS !== '0'
// UC gates the API on device/version headers (no auth token needed for guest).
const DEVICE_ID = `v-${Date.now()}`

interface City {
  cityKey: string
  slug: string
  lat: number
  lon: number
  label: string
}
// UC scopes the catalog by `cityKey` (pattern `city_<slug>_v2`). These metros are
// each verified live (scripts/uc-citykeys-probe.ts → 30 services). NCR satellite
// towns (Gurgaon/Noida/Faridabad) fold into Delhi (Gurugram coords + city_delhi_v2
// returns results). A client location resolves to the nearest of these.
const METROS: City[] = [
  { cityKey: 'city_bangalore_v2', slug: 'bangalore', lat: 12.9719, lon: 77.5937, label: 'Bangalore' },
  { cityKey: 'city_mumbai_v2', slug: 'mumbai', lat: 19.076, lon: 72.8777, label: 'Mumbai' },
  { cityKey: 'city_delhi_v2', slug: 'delhi', lat: 28.6139, lon: 77.209, label: 'Delhi NCR' },
  { cityKey: 'city_pune_v2', slug: 'pune', lat: 18.5204, lon: 73.8567, label: 'Pune' },
  { cityKey: 'city_hyderabad_v2', slug: 'hyderabad', lat: 17.385, lon: 78.4867, label: 'Hyderabad' },
  { cityKey: 'city_chennai_v2', slug: 'chennai', lat: 13.0827, lon: 80.2707, label: 'Chennai' },
  { cityKey: 'city_kolkata_v2', slug: 'kolkata', lat: 22.5726, lon: 88.3639, label: 'Kolkata' },
  { cityKey: 'city_ahmedabad_v2', slug: 'ahmedabad', lat: 23.0225, lon: 72.5714, label: 'Ahmedabad' },
  { cityKey: 'city_jaipur_v2', slug: 'jaipur', lat: 26.9124, lon: 75.7873, label: 'Jaipur' },
  { cityKey: 'city_chandigarh_v2', slug: 'chandigarh', lat: 30.7333, lon: 76.7794, label: 'Chandigarh' },
]
const byslug = (s: string) => METROS.find((m) => m.slug === s.toLowerCase())
// Current city (cityKey + slug for deep links) and the live search coords. The
// coords track the client's real location; the cityKey is the nearest metro's.
let city: City = byslug(process.env.UC_CITY ?? 'bangalore') ?? METROS[0]

/** Great-circle-ish distance (km) — enough to pick the nearest metro. */
function distKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371
  const dLat = ((bLat - aLat) * Math.PI) / 180
  const dLon = ((bLon - aLon) * Math.PI) / 180
  const la1 = (aLat * Math.PI) / 180
  const la2 = (bLat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Resolve a client location to the nearest supported metro (keeping the client's
 * exact coords for the search, which UC accepts within the metro's region). */
function nearestMetro(lat: number, lon: number): { city: City; km: number } {
  let best = METROS[0]
  let bestKm = Number.POSITIVE_INFINITY
  for (const m of METROS) {
    const km = distKm(lat, lon, m.lat, m.lon)
    if (km < bestKm) {
      bestKm = km
      best = m
    }
  }
  return { city: best, km: bestKm }
}

let ready: Promise<{ browser: Browser; ctx: BrowserContext; page: Page }> | null = null

function apiHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'x-brand-key': 'urbanCompany',
    'x-device-id': DEVICE_ID,
    'x-device-os': 'desktop_web',
    'x-version-code': '4.273.58',
    'x-version-name': 'web_v4.273.58',
    'react-bundle-version': '798',
    'x-preferred-language': 'english',
    'accept-language': 'en-IN',
  }
}

async function ensureReady() {
  if (ready) return ready
  ready = (async () => {
    const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: HEADLESS })
    const page = await ctx.newPage()
    // Land on the city page once: clears Cloudflare + sets the urbancompany.com
    // origin the cross-origin API fetch runs from.
    await page.goto(`https://www.urbancompany.com/${city.slug}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(2500)
    return { browser, ctx, page }
  })()
  return ready
}

/** POST a UC api/v2 endpoint from inside the page (real TLS + CF cookies).
 * Cloudflare is cleared by our headless identity; `token` (a captured Bearer
 * token) adds account auth — the two are independent (CF ⊥ auth). */
export async function apiPost(path: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  const { page } = await ensureReady()
  const headers = { ...apiHeaders(), ...(token ? { authorization: `Bearer ${token}` } : {}) }
  return page.evaluate(
    async ({ url, headers, body }) => {
      const res = await fetch(url, { method: 'POST', credentials: 'omit', headers, body: JSON.stringify(body) })
      let json: unknown = null
      try {
        json = await res.json()
      } catch {
        /* non-json */
      }
      return { status: res.status, json }
    },
    { url: `https://www.urbanclap.com/api/v2/${path}`, headers, body },
  )
}

export function currentCoords(): { lat: number; lon: number } {
  return { lat: city.lat, lon: city.lon }
}

/** Catalog search (our search_catalog) → discoverySearch layout JSON. Guest. */
export async function searchServices(query: string): Promise<unknown> {
  const { status, json } = await apiPost('growth/search/discoverySearch', {
    city_key: null,
    location: { longitude: city.lon, latitude: city.lat },
    cityKey: city.cityKey,
    searchToken: query,
    source: 'homescreen',
    sourceMetadata: { pageName: 'homescreen' },
    recentSearches: [],
  })
  if (status !== 200) throw new Error(`UC discoverySearch HTTP ${status} for "${query}"`)
  return json
}

/** Category page (initiateSeoJourney) for a service — carries the earliest-slot
 * widget + package options. Best-effort: returns null if it doesn't resolve. */
export async function fetchCategory(deepLinkUrl: string): Promise<unknown> {
  const { status, json } = await apiPost('growth/customerJourney/initiateSeoJourney', {
    city_key: null,
    url: deepLinkUrl,
    utmContext: { utmCampaign: null, utmContent: null, utmMedium: null, utmSource: 'direct', utmTerm: null, userLanding: null },
  })
  return status === 200 ? json : null
}

/** The web URL for a category — the human's booking handoff (slug = key with
 * underscores → hyphens, verified: professional_home_cleaning →
 * bangalore-professional-home-cleaning). */
export function deepLink(categoryKey: string): string {
  return `https://www.urbancompany.com/${city.slug}-${categoryKey.replace(/_/g, '-')}`
}

/** Pin the search location from a real client: resolve it to the nearest
 * supported metro (so cityKey and coords stay in sync — a mismatch returns 0
 * results) while keeping the client's exact coords. Returns the resolved city
 * label + how far the client is from it (a large distance ⇒ likely unserved). */
export function setCoords(lat: number, lon: number): { label: string; km: number; serviceable: boolean } {
  const { city: m, km } = nearestMetro(lat, lon)
  // Search with the metro CENTRE, not the client's exact coords: UC returns
  // generic `category` results at edge/satellite coords but specific bookable
  // `service_package` results at the hub centre, and home services are
  // city-level anyway (the exact address is entered on UC at booking).
  city = m
  // UC serves metros + their regions; beyond ~150km from any hub, treat as unserved.
  return { label: m.label, km, serviceable: km <= 150 }
}
export function hasLocation(): boolean {
  return true // a serviceable metro is always established by default
}
/** Same resolution as `setCoords`, but read-only — for a one-off address (e.g.
 * a booking-address override that differs from the session's search location)
 * without mutating the module-global `city` every other call in this session
 * relies on. */
export function nearestMetroFor(lat: number, lon: number): { label: string; cityKey: string; slug: string; km: number; serviceable: boolean } {
  const { city: m, km } = nearestMetro(lat, lon)
  return { label: m.label, cityKey: m.cityKey, slug: m.slug, km, serviceable: km <= 150 }
}
export function currentCity(): { label: string; cityKey: string; slug: string } {
  return { label: city.label, cityKey: city.cityKey, slug: city.slug }
}

export async function closeClient(): Promise<void> {
  if (!ready) return
  const r = await ready.catch(() => null)
  await r?.browser.close().catch(() => {})
  ready = null
}
