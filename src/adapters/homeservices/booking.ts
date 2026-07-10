/**
 * Urban Company authenticated booking chain (Tier B, DESIGN §14) — the part
 * past login. Once `auth.ts` has captured a real per-user Bearer token, this
 * drives the full server-driven-UI journey headlessly AS that user: resolve a
 * bookable package for the searched service, build the cart, geocode + save a
 * real address, and fetch the real slot grid. STOPS before payment.
 *
 * Reverse-engineered from a live captured trace (scratchpad/uc/booking/) of a
 * real booking through slot-select. The chain is a server-driven-UI app: each
 * step's response often embeds the *next* step's request as a ready-made
 * `onButtonPress` payload (see `findSlotRequestTemplate`) — we relay those
 * rather than reconstructing UC's internal ids (fulfillment/inventory tags,
 * variant-mapping ids) from scratch, which aren't derivable any other way.
 *
 * Every step below is real, but only verified against ONE live account/city/
 * category combination — different categories may have different
 * customization shapes. Fails loudly with a step name so a live retry is
 * debuggable rather than silently wrong.
 */
import { apiPost } from './client'

// biome-ignore lint/suspicious/noExplicitAny: server-driven-UI trees, typed loosely
type Any = any

function findDeep(obj: Any, key: string): Any {
  if (!obj || typeof obj !== 'object') return undefined
  if (key in obj) return obj[key]
  for (const v of Object.values(obj)) {
    const r = findDeep(v, key)
    if (r !== undefined) return r
  }
  return undefined
}

/** Find the FIRST object anywhere in the tree that looks like a ready-made
 * slot-page request (has both `lineItems` and `groupId` alongside a
 * `draftOrderId`) — UC embeds this as a button's `onButtonPress.data` once the
 * address is applied, so we relay it instead of rebuilding its opaque ids. */
function findSlotRequestTemplate(obj: Any): Any {
  if (!obj || typeof obj !== 'object') return undefined
  if (obj.lineItems && obj.groupId && obj.draftOrderId) return obj
  for (const v of Object.values(obj)) {
    const r = findSlotRequestTemplate(v)
    if (r !== undefined) return r
  }
  return undefined
}

interface PackageCard {
  packageId: number
  name: string
  price: number
}

/** Package cards live in `initiateJourney`'s dataStore, keyed like
 * `"<packageId>#null"`, each carrying a `heading`/`priceText`. */
function extractPackageCards(initJson: unknown): PackageCard[] {
  const dataStore = (initJson as Any)?.success?.data?.dataStore ?? {}
  const out: PackageCard[] = []
  for (const [key, node] of Object.entries<Any>(dataStore)) {
    const m = /^(\d+)#/.exec(key)
    if (!m || !node?.heading?.textValue) continue
    const priceMatch = /₹\s*([\d,]+)/.exec(node.priceText?.textValue ?? '')
    out.push({ packageId: Number(m[1]), name: String(node.heading.textValue), price: priceMatch ? Number(priceMatch[1].replace(/,/g, '')) : 0 })
  }
  return out
}

/** `getEditablePackageDetailScreen` 500s (rpc_internal_server_error) unless the
 * request echoes back the full package object the client was already handed —
 * this is a server-driven-UI app, so the server doesn't reconstruct catalog
 * data from a bare packageId. The real shape lives in a SEPARATE dataStore map,
 * `dataStore.packagesData["<packageId>#null"]` (componentId/base/details/
 * selectedVariants/…), distinct from the sku-card widget `extractPackageCards`
 * reads for name/price — confirmed byte-for-byte against a live capture
 * (scratchpad/uc/booking/00-res.json → 01-req.json's `packageData`). */
function extractPackagesDataMap(initJson: unknown): Record<number, Any> {
  const packagesData = (initJson as Any)?.success?.data?.dataStore?.packagesData ?? {}
  const out: Record<number, Any> = {}
  for (const [key, node] of Object.entries<Any>(packagesData)) {
    const m = /^(\d+)#/.exec(key)
    if (m) out[Number(m[1])] = node
  }
  return out
}

/** Pick the package card matching the guest-search result the agent already
 * selected — by name similarity, falling back to closest price, then first. */
function pickPackage(cards: PackageCard[], wantName: string, wantPrice: number): PackageCard {
  if (cards.length === 0) throw new Error('no bookable packages found for this category')
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const target = norm(wantName)
  const byName = cards.find((c) => norm(c.name) === target) ?? cards.find((c) => norm(c.name).includes(target) || target.includes(norm(c.name)))
  if (byName) return byName
  return cards.reduce((best, c) => (Math.abs(c.price - wantPrice) < Math.abs(best.price - wantPrice) ? c : best), cards[0])
}

interface CustomizationSelection {
  packages: Any[]
  groupId: string
}

/** Build a `packages[]` entry for `updatePackageSelection` from the package
 * detail screen's customization steps — mandatory single/multi-select steps
 * get their first option (a safe, minimal default: the base configuration);
 * optional add-on steps are left unselected. */
async function resolvePackageSelection(opts: {
  packageId: number
  name: string
  categoryKey: string
  cityKey: string
  lat: number
  lon: number
  token: string
  packageData: Any
  draftOrderId: string
}): Promise<CustomizationSelection> {
  const { packageId, name, categoryKey, cityKey, lat, lon, token, packageData, draftOrderId } = opts
  const { status, json } = await apiPost(
    'growth/customerJourney/getEditablePackageDetailScreen',
    { city_key: null, packageId, cityKey, sourceScreen: 'myop', categoryKey, location: { lat, long: lon }, userId: '', packageData, draftOrderId, associatedPackages: [] },
    token,
  )
  if (status !== 200) throw new Error(`getEditablePackageDetailScreen HTTP ${status}`)
  const groupId = String(findDeep(json, 'draftOrderId') ?? '')
  const steps: Any[] = (json as Any)?.success?.data?.dataStore?.commonInfo?.customizationSteps ?? []

  const variants: Any[] = []
  const variantOptions: Any[] = []
  for (const step of steps) {
    if (!step.isMandatory) continue // optional add-ons: leave unselected (base package only)
    const item = step.stepItems?.[0]
    if (!item) continue
    const meta = item.stepItemMetaData?.variantIds
    const ids: number[] = meta?.variant_ids ?? []
    const qty: Record<string, number> = meta?.variant_quantity ?? {}
    for (const id of ids) variants.push({ id, quantity: qty[String(id)] ?? 1 })
    variantOptions.push({
      optionKey: item.id,
      variants: ids.map((id) => ({ variantId: id, quantity: qty[String(id)] ?? 1 })),
      quantity: 1,
      selection: {},
      lineItemName: item.name,
    })
  }

  return {
    groupId,
    packages: [{ id: packageId, quantity: 1, variants, variantOptions, planOptions: [], name, type: 'tweakable', packageType: 'service_item', packageUIType: 'SCOPING_WIDGET' }],
  }
}

export interface AuthedBookingInput {
  categoryKey: string
  cityKey: string
  lat: number
  lon: number
  ucUserId: string
  token: string
  wantName: string
  wantPrice: number
  houseNumber: string
  landmark?: string
  recipientName: string
}

export interface AuthedBookingResult {
  draftOrderId: string
  packageName: string
  addressId: string
  formattedAddress: string
  slots: string[]
  /** True when the slot-page came back empty AND UC's own response says so
   * explicitly (e.g. "Notify when slots are available") — a real, correct "no
   * pros in this area right now," not a parsing failure. */
  noAvailability: boolean
  raw: unknown
}

/** The full chain: resolve package → build cart → geocode + save address →
 * apply to draft → fetch the real slot grid. Throws with the failing step
 * named, so a live retry is debuggable. STOPS before payment — nothing here
 * crosses into `getCheckoutJourneyPaymentPage` or any payment call. */
export async function buildAuthenticatedBooking(input: AuthedBookingInput): Promise<AuthedBookingResult> {
  const { categoryKey, cityKey, lat, lon, ucUserId, token, wantName, wantPrice, houseNumber, landmark, recipientName } = input

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      throw new Error(`[${name}] ${e instanceof Error ? e.message : e}`)
    }
  }

  const initRes = await step('initiateJourney', async () => {
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
    if (status !== 200) throw new Error(`HTTP ${status}`)
    return json
  })
  const draftOrderId = String(findDeep(initRes, 'draftOrderId') ?? String(findDeep((initRes as Any)?.success?.data?.dataStore?.fjMetaData, 'fjId') ?? '').split('_')[0])
  const groupId1 = String((initRes as Any)?.success?.data?.layout?.id ?? '')
  if (!draftOrderId || !groupId1) throw new Error('[initiateJourney] no draftOrderId/groupId in response')

  const pkg = pickPackage(extractPackageCards(initRes), wantName, wantPrice)
  const packageData = extractPackagesDataMap(initRes)[pkg.packageId]
  if (!packageData) throw new Error(`[initiateJourney] no packagesData entry for picked package ${pkg.packageId}`)

  const selection = await step('getEditablePackageDetailScreen', () => resolvePackageSelection({ packageId: pkg.packageId, name: pkg.name, categoryKey, cityKey, lat, lon, token, packageData, draftOrderId }))

  await step('updatePackageSelection', async () => {
    const { status } = await apiPost(
      'growth/customerJourney/updatePackageSelection',
      { city_key: null, draftOrderId, packages: selection.packages, groupId: groupId1, coordinates: { lat, long: lon }, shouldFetchNextPrice: false, productContext: { carouselMappings: [] }, source: 'customerApplications', useCase: 'multiCategoryCheckoutDesktop', categoryKey },
      token,
    )
    if (status !== 200) throw new Error(`HTTP ${status}`)
  })

  const groupId2 = await step('getNextGroup', async () => {
    const { status, json } = await apiPost(
      'growth/customerJourney/getNextGroup',
      { city_key: null, draftOrderId, currentGroupId: groupId1, subscription: { planId: null }, recommendedPackagesFlow: { isFacialRecommendationsEnabled: false }, source: 'customerApplications', useCase: 'multiCategoryCheckoutDesktop', isFjEnabled: true, navigationStack: ['categoryPage'], cityKey },
      token,
    )
    if (status !== 200) throw new Error(`HTTP ${status}`)
    const id = (json as Any)?.success?.data?.data?.id
    if (!id) throw new Error('no next groupId in response')
    return String(id)
  })

  const address = await step('reverseGeoCode', async () => {
    const { status, json } = await apiPost('growth/locations/reverseGeoCode', { city_key: null, coordinate: { latitude: lat, longitude: lon, accuracy: 35 } }, token)
    if (status !== 200) throw new Error(`HTTP ${status}`)
    const loc = (json as Any)?.success?.data?.location
    if (!loc) throw new Error('no location in response')
    return loc
  })

  // Best-effort: primes the address form server-side; not required for proceedWithAddress to work.
  await apiPost('growth/profile/getAddressForm', { city_key: null, userId: '', cityKey, countryKey: 'IND', searchedLocation: address, locationDetails: { lat, long: lon }, sourceScreen: 'summary' }, token).catch(() => {})

  const addressId = await step('proceedWithAddress', async () => {
    const { status, json } = await apiPost(
      'growth/profile/proceedWithAddress',
      {
        city_key: null,
        location: {
          accuracy: 0,
          address: '',
          city: address.cityName ?? '',
          city_key: address.cityKey ?? cityKey,
          name: 'Home',
          recipient_name_obj: { name: recipientName, title: '' },
          pin_code: address.postalCode ?? '',
          point: [lon, lat],
          show_map: false,
          google_place_id: address.place_id ?? address.placeId,
          state: address.stateName ?? '',
          locality: address.locality ?? address.formatted_address ?? '',
          geoProofingLocality: address.geoProofingLocality,
        },
        sourceScreen: 'summary',
        userJourneyCityKey: cityKey,
        modifiedFields: { house_number: houseNumber, landmark: landmark ?? '', name: recipientName },
      },
      token,
    )
    if (status !== 200) throw new Error(`HTTP ${status}`)
    const id = (json as Any)?.success?.data?.location?._id ?? (json as Any)?.success?.data?.location?.addressId
    if (!id) throw new Error('no addressId in response')
    return String(id)
  })

  // Best-effort: pre-checks package availability at the new address; the real
  // state change (and the slot-request template) comes from updateAddressInDraftOrder next.
  await apiPost('growth/customerJourney/checkPackageUpdatesAtNewLocation', { city_key: null, draftOrderId, inputAddress: { _id: addressId }, groupId: groupId2, useCase: 'multiCategoryCheckoutDesktop' }, token).catch(() => {})

  const addrDraftRes = await step('updateAddressInDraftOrder', async () => {
    const { status, json } = await apiPost('growth/customerJourney/updateAddressInDraftOrder', { city_key: null, draftOrderId, groupId: groupId2, selectedAddress: { _id: addressId }, useCase: 'multiCategoryCheckoutDesktop' }, token)
    if (status !== 200) throw new Error(`HTTP ${status}`)
    return json
  })

  const slotTemplate = findSlotRequestTemplate(addrDraftRes)
  if (!slotTemplate) throw new Error('[updateAddressInDraftOrder] no slot-page request template found in response — the account/category shape may differ from the captured trace')

  const slotRes = await step('getCheckoutJourneySlotPage', async () => {
    const { status, json } = await apiPost(
      'marketplace/capacityOrionPL/customerFacing/getCheckoutJourneySlotPage',
      { city_key: null, action: 'createNewRequest', isScheduleBlockSelected: false, isEditAddressEnabled: true, ...slotTemplate },
      token,
    )
    if (status !== 200) throw new Error(`HTTP ${status}`)
    return json
  })

  const slots = extractSlots(slotRes)
  const noAvailability = slots.length === 0 && /Notify when slots are available|no pro(fessional)?s? available|not available/i.test(JSON.stringify(slotRes))

  return { draftOrderId, packageName: pkg.name, addressId, formattedAddress: address.formatted_address ?? address.formattedAddress ?? '', slots, noAvailability, raw: slotRes }
}

/** Pull human-readable slot signals out of the slot-page response — epoch-ms
 * timestamps and day/time strings (same heuristic proven in
 * scripts/uc-auth-slots.ts against a live response). */
function extractSlots(json: unknown, out: string[] = [], depth = 0): string[] {
  if (!json || typeof json !== 'object' || depth > 12) return out
  for (const [k, v] of Object.entries(json as Any)) {
    if (/time|slot|date|epoch|start/i.test(k) && typeof v === 'number' && v > 1_700_000_000_000) out.push(`${k}=${new Date(v).toISOString().slice(0, 16)}`)
    if (typeof v === 'string' && /^\d{1,2}:\d{2}\s*(am|pm)|\b(mon|tue|wed|thu|fri|sat|sun)\b|today|tomorrow/i.test(v) && v.length < 30) out.push(`${k}="${v}"`)
    extractSlots(v, out, depth + 1)
  }
  return [...new Set(out)].slice(0, 30)
}
