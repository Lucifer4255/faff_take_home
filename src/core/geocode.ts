/**
 * Free-text → coordinates, shared across adapters (DESIGN.md §10 open item —
 * "geocoding provider for P1", never resolved because delivery was scoped out;
 * homeservices' "book a different address" case needs it too, so it lives here
 * rather than per-adapter).
 *
 * Provider: OpenStreetMap Nominatim's public API — no signup, no key, no
 * billing, which matters for a take-home nobody else can just `git clone` and
 * run. Usage policy (https://operations.osmfoundation.org/policies/nominatim/)
 * requires a real User-Agent and caps the public instance at ~1 req/sec, both
 * honored below. Good enough India coverage for real street addresses; not as
 * precise as Google/Mapbox on ambiguous queries — swap the implementation for
 * one of those (both need an API key) if that becomes a problem.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/search'
const USER_AGENT = 'faff-take-home/1.0 (agentic-commerce harness; contact via repo)'

let lastCallAt = 0
async function throttle(): Promise<void> {
  const wait = lastCallAt + 1100 - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastCallAt = Date.now()
}

export interface GeocodeResult {
  lat: number
  lon: number
  formattedAddress: string
}

/** Resolve free text to a single best-match coordinate, or `null` if nothing
 * matched — callers must treat `null` as "don't guess," not "use a default,"
 * since a wrong guess here means a real professional dispatched to the wrong
 * home (or a grocery order to the wrong door). */
export async function geocodeAddress(text: string): Promise<GeocodeResult | null> {
  const q = text.trim()
  if (!q) return null
  await throttle()
  const url = `${ENDPOINT}?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(q)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`geocode HTTP ${res.status}`)
  const json = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>
  const hit = json[0]
  if (!hit) return null
  return { lat: Number(hit.lat), lon: Number(hit.lon), formattedAddress: hit.display_name }
}
