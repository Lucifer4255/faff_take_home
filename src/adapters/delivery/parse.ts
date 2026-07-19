/**
 * Uber (P1) response parsers — pure, over the shapes captured live via
 * Claude-in-Chrome (see scratchpad/uber-capture.md). Kept separate from the
 * browser transport (client.ts) exactly like blinkit/parse.ts and
 * homeservices/parse.ts, so the "cracked the API" logic is testable in isolation.
 */

/** A place from `POST www.uber.com/api/pudoLocationSearch`. Carries a Google
 * Places `id` but NO coordinates — those come from getPlaceDetails (parsePlace). */
export interface UberPlace {
  id: string
  provider: string
  addressLine1: string
  addressLine2?: string
  confidence?: string
}

/** A fully-resolved location from `POST /api/getPlaceDetails` — this is the node
 * shape the m.uber.com booking deep link + TripRequest expect. */
export interface UberLocation {
  id: string
  provider: string
  title: string
  addressLine1: string
  addressLine2?: string
  fullAddress?: string
  latitude: number
  longitude: number
}

/** One ride option from the `Products` GraphQL op (m.uber.com/go/graphql). */
export interface UberProduct {
  /** vehicleViewId — the `vehicle=` param in the deep link + product identity. */
  vvid?: string
  displayName: string
  description?: string
  capacity?: number
  etaInMin?: number
  estimatedTripTime?: number
  /** Formatted, e.g. "₹104.99". */
  fare: string
  /** Numeric fare in major units (₹104.99), derived from fareAmountE5 / 1e5. */
  fareValue: number
  currency: string
  /** Opaque fare token (fares[].meta) — required by the TripRequest book mutation. */
  meta?: string
}

/** One live-tracking snapshot from the `GetStatus` GraphQL op (polled after a
 * ride is dispatched). Field names for status/driver are discovered live on the
 * first real trip; parsed defensively over the JSON so an unknown shape still
 * yields *something* rather than throwing. */
export interface TripSnapshot {
  at: number
  /** clientStatus: Looking | Dispatching | WaitingForPickup | OnTrip | ... */
  status?: string
  driver?: string
  driverRating?: number
  /** "<make> <model>" (or the product name until a real vehicle is assigned). */
  vehicle?: string
  plate?: string
  /** Live driver/vehicle location (0,0 until a driver is assigned → omitted then). */
  driverLat?: number
  driverLng?: number
  bearing?: number
  /** Straight-line metres from the driver to the pickup (when driver loc is known). */
  distanceToPickupM?: number
  /** Human ETA string ("3 min"), and raw eta seconds — populated once matched. */
  etaText?: string
  etaSeconds?: number
  fare?: string
  /** Ride verification PIN (trip.pinVerification.pin). */
  pin?: string
  cancelable?: boolean
  /** Nearby vehicles on the map (pre-match "Looking" state). */
  nearbyVehicles?: number
  rawSlice?: string
}

const R = 6_371_000 // earth radius, metres
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(s)))
}

/**
 * Parse a GetStatus response → TripSnapshot. Shape captured live:
 * `data.status.{ clientStatus, coordinate, nearbyVehicles[], trip{ driver, vehicle,
 * eta, etaStringShort, pinVerification, fareString, waypoints[], cancelable } }`.
 * driver/vehicle fields are empty (name:"", coord 0,0) until a driver is assigned,
 * then populate with the real driver + live vehicle location.
 */
export function parseStatus(json: unknown, now: number): TripSnapshot {
  // biome-ignore lint: Uber GetStatus tree, walked over the known shape
  const st = (json as any)?.data?.status
  const base: TripSnapshot = { at: now, rawSlice: JSON.stringify(json ?? {}).slice(0, 300) }
  if (!st) return base
  const trip = st.trip
  if (!trip) return { ...base, status: st.clientStatus, nearbyVehicles: Array.isArray(st.nearbyVehicles) ? st.nearbyVehicles.length : undefined }

  const v = trip.vehicle ?? {}
  const drv = trip.driver ?? {}
  const vloc = v.coordinate ?? {}
  const dLat = Number(vloc.latitude)
  const dLng = Number(vloc.longitude)
  const hasDriverLoc = Number.isFinite(dLat) && Number.isFinite(dLng) && (dLat !== 0 || dLng !== 0)
  // biome-ignore lint: waypoint node
  const wps: any[] = Array.isArray(trip.waypoints) ? trip.waypoints : []
  // biome-ignore lint: waypoint node
  const pickupWp = wps.find((w: any) => w.type === 'Pickup') ?? wps[0]
  const pickup = pickupWp?.coordinate

  // Live ETA: the moment a driver/vehicle is assigned (i.e. when live coordinates
  // appear on trip.vehicle.coordinate), the trip-level etaStringShort often goes
  // blank while the moving "N min" lives on the vehicle, the statusMessage, or the
  // pickup waypoint's etaInSeconds. Fall through all of them so ETA shows *with*
  // the coords, and synthesize "N min" from seconds when only a number is present.
  const wpEtaSec = Number(pickupWp?.etaInSeconds)
  const etaSeconds = Number(trip.eta) || (Number.isFinite(wpEtaSec) && wpEtaSec > 0 ? wpEtaSec : undefined) || undefined
  const etaText =
    trip.etaStringShort ||
    v.etaStringShort ||
    trip.statusMessage?.subtitle ||
    trip.statusMessage?.title ||
    (etaSeconds ? `${Math.max(1, Math.round(etaSeconds / 60))} min` : undefined) ||
    undefined

  return {
    ...base,
    status: trip.clientStatus ?? st.clientStatus,
    driver: drv.name || undefined,
    driverRating: drv.rating || undefined,
    vehicle: [v.make, v.model].filter(Boolean).join(' ') || v.description || undefined,
    plate: v.licensePlate || undefined,
    driverLat: hasDriverLoc ? dLat : undefined,
    driverLng: hasDriverLoc ? dLng : undefined,
    bearing: hasDriverLoc && v.bearing ? v.bearing : undefined,
    distanceToPickupM: hasDriverLoc && pickup ? haversineM(dLat, dLng, Number(pickup.latitude), Number(pickup.longitude)) : undefined,
    etaText,
    etaSeconds,
    fare: trip.fareString || undefined,
    pin: trip.pinVerification?.pin || undefined,
    cancelable: typeof trip.cancelable === 'boolean' ? trip.cancelable : undefined,
  }
}

/** pudoLocationSearch → list of candidate places (id + label, no coords). */
export function parsePlaceSearch(json: unknown): UberPlace[] {
  const data = (json as { data?: unknown })?.data
  // `data` is an array of result objects (numeric-keyed when serialized).
  const rows: unknown[] = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data as object) : []
  const out: UberPlace[] = []
  for (const r of rows) {
    const o = r as Record<string, unknown>
    if (o && typeof o.id === 'string' && typeof o.addressLine1 === 'string') {
      out.push({
        id: o.id,
        provider: String(o.provider ?? 'google_places'),
        addressLine1: o.addressLine1,
        addressLine2: typeof o.addressLine2 === 'string' ? o.addressLine2 : undefined,
        confidence: typeof o.confidence === 'string' ? o.confidence : undefined,
      })
    }
  }
  return out
}

/** getPlaceDetails → a resolved location with coordinates, or null if unusable. */
export function parsePlace(json: unknown): UberLocation | null {
  const d = (json as { data?: Record<string, unknown> })?.data
  if (!d) return null
  const lat = Number(d.lat)
  const lon = Number(d.long)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return {
    id: String(d.id ?? ''),
    provider: String(d.provider ?? 'google_places'),
    title: String(d.title ?? d.addressLine1 ?? ''),
    addressLine1: String(d.addressLine1 ?? ''),
    addressLine2: typeof d.addressLine2 === 'string' ? d.addressLine2 : undefined,
    fullAddress: typeof d.fullAddress === 'string' ? d.fullAddress : undefined,
    latitude: lat,
    longitude: lon,
  }
}

/** The JSON object each pickup/drop is serialized to in the product-selection
 * deep link and TripRequest. `source:"SEARCH"` marks a user-searched place. */
export function toDeepLinkNode(loc: UberLocation) {
  return {
    addressLine1: loc.addressLine1,
    addressLine2: loc.addressLine2 ?? '',
    fullAddress: loc.fullAddress ?? loc.addressLine1,
    id: loc.id,
    source: 'SEARCH',
    latitude: loc.latitude,
    longitude: loc.longitude,
    provider: loc.provider,
    title: loc.title,
  }
}

/**
 * Build the booking-ready deep link — the Tier-A (no-login) handoff, the direct
 * analogue of Blinkit's shared-cart link. Opening it in a logged-in browser lands
 * on m.uber.com's "Choose a ride" with pickup+drop (and optional vehicle) filled.
 */
export function buildDeepLink(pickup: UberLocation, drop: UberLocation, vvid?: string): string {
  const p = encodeURIComponent(JSON.stringify(toDeepLinkNode(pickup)))
  const d = encodeURIComponent(JSON.stringify(toDeepLinkNode(drop)))
  const v = vvid ? `&vehicle=${encodeURIComponent(vvid)}` : ''
  return `https://m.uber.com/go/product-selection?pickup=${p}&drop[0]=${d}${v}`
}

/** Parse the `Products` GraphQL response → ride options with fares. Walks the
 * tiers[].products[] tree defensively (persisted-query response, loosely typed). */
export function parseProducts(json: unknown): UberProduct[] {
  // biome-ignore lint: Uber GraphQL products tree, walked loosely
  const products = (json as any)?.data?.products
  if (!products) return []
  const out: UberProduct[] = []
  const tiers: unknown[] = Array.isArray(products.tiers) ? products.tiers : []
  for (const tier of tiers) {
    // biome-ignore lint: tier node
    const list: unknown[] = Array.isArray((tier as any)?.products) ? (tier as any).products : []
    for (const p of list) {
      // biome-ignore lint: product node
      const o = p as any
      const fare0 = Array.isArray(o?.fares) ? o.fares[0] : undefined
      if (!o?.displayName || !fare0) continue
      const e5 = Number(fare0.fareAmountE5)
      out.push({
        // `id` is the numeric vehicleViewId (e.g. 2022 = Uber Go AC) — matches
        // the deep link's `vehicle=` param + defaultVVID. UUID fields are fallbacks.
        vvid: o.id != null ? String(o.id) : o.vehicleViewUuid != null ? String(o.vehicleViewUuid) : o.productUuid != null ? String(o.productUuid) : undefined,
        displayName: String(o.displayName),
        description: typeof o.detailedDescription === 'string' ? o.detailedDescription : typeof o.description === 'string' ? o.description : undefined,
        capacity: Number.isFinite(Number(fare0.capacity)) ? Number(fare0.capacity) : Number.isFinite(Number(o.capacity)) ? Number(o.capacity) : undefined,
        etaInMin: Number.isFinite(Number(o.etaInMin)) ? Number(o.etaInMin) : undefined,
        estimatedTripTime: Number.isFinite(Number(o.estimatedTripTime)) ? Number(o.estimatedTripTime) : undefined,
        fare: String(fare0.fare ?? ''),
        fareValue: Number.isFinite(e5) ? e5 / 1e5 : Number.NaN,
        currency: String(o.currencyCode ?? 'INR'),
        meta: typeof fare0.meta === 'string' ? fare0.meta : undefined,
      })
    }
  }
  return out
}
