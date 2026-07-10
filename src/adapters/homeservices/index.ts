import type { Adapter } from '@/core/adapter'
import { geocodeAddress } from '@/core/geocode'
import { JsonStore } from '@/core/store'
import { authFor, isLoggedIn, sendLoginCode as authSendLoginCode, verifyLoginCode as authVerifyLoginCode } from './auth'
import { driveToPay } from './browserDrive'
import { closeClient, currentCity, currentCoords, deepLink, fetchCategory, hasLocation, nearestMetroFor, searchServices, setCoords } from './client'
import { type UCService, extractEarliestSlot, extractServices } from './parse'

/**
 * Home Services adapter (P2, Urban Company — DESIGN.md §7, §14).
 *
 * Validates the harness abstraction on a *different-shaped* target than Blinkit:
 * slots/availability, not a cart. The load-bearing "cracked the API not the DOM"
 * part is `search_catalog` → UC's real `discoverySearch` endpoint (through the
 * Chromium TLS vehicle — see client.ts), parsed into services.
 *
 * Two tiers, chosen automatically per session:
 * - **Guest** (no login) — a **booking-ready handoff**: chosen service + price
 *   + earliest availability + a deep link; the human opens it and finishes
 *   (login + exact slot + pay) in-app. No spend, no login needed.
 * - **Authenticated** (`needsLogin`/`sendLoginCode`/`verifyLoginCode`, see
 *   auth.ts) — UC's Cloudflare Turnstile only rejects *scripted* Turnstile/OTP
 *   submission, not a real human clearing it in a real, visible browser window
 *   (verified live); once that human-cleared session is captured, `booking.ts`
 *   drives the real chain (package selection, a real geocoded address, the
 *   real slot grid — see @/core/geocode for a requested address that differs
 *   from the client's current location) headlessly AS that user, under their
 *   own account, still stopping one call short of payment.
 */

interface Booking {
  id: string
  name: string
  category: string
  price: number
  startsAt: boolean
  categoryKey: string
  earliestSlot?: string
  /** Set only if the user asked for somewhere other than their current
   * location. We have no free-text geocoder (see delivery/index.ts's TODO —
   * scoped out project-wide), so we can't safely turn this into coordinates
   * ourselves; `confirm` uses it only to detect "this isn't my location" and
   * degrade to the guest handoff rather than risk booking the wrong address. */
  addressOverride?: string
}
const bookings = new JsonStore<Booking>('.data/uc-bookings.json')

// Per-session cache of the last search results so select_slot can resolve an
// id → the service snapshot without re-hitting UC.
const searchCache = new Map<string, Map<string, UCService>>()
function remember(sessionId: string, services: UCService[]): void {
  let byId = searchCache.get(sessionId)
  if (!byId) searchCache.set(sessionId, (byId = new Map()))
  for (const s of services) byId.set(s.id, s)
}

function bookingState(sessionId: string) {
  const b = bookings.get(sessionId)
  const loc = currentCity()
  if (!b) return { selected: false, city: loc.label, note: 'No service selected yet — search, then select one.' }
  const price = b.startsAt ? `from ₹${b.price}` : `₹${b.price}`
  return {
    selected: true,
    service: b.name,
    category: b.category,
    price,
    priceValue: b.price,
    currency: 'INR',
    earliestSlot: b.earliestSlot,
    city: loc.label,
    // The booking handoff: the human opens this to pick the exact slot, log in
    // (Cloudflare Turnstile — human-only) and pay. Nothing is charged by us.
    // Named `checkoutUrl` so the harness surfaces it (web button, CLI, Session).
    checkoutUrl: deepLink(b.categoryKey),
    note: 'Booking-ready. Open the link to choose your exact time slot, sign in and confirm — nothing is charged until you do.',
  }
}

export const homeservices: Adapter = {
  service: 'homeservices',
  // UC is location-first (results are per city). Resolve the client location to
  // the nearest supported metro (keeping their exact coords) so search is scoped
  // correctly — a coords/cityKey mismatch returns zero services.
  configureLocation: async (lat, lon) => {
    const { label, serviceable } = setCoords(lat, lon)
    return { label, serviceable }
  },
  hasLocation: () => hasLocation(),
  // Per-user account login (§ the CAPTCHA wall). We never script Turnstile or
  // the OTP — sendLoginCode opens a real, visible browser window and pre-fills
  // the phone; the human personally clears Turnstile + enters the OTP there;
  // verifyLoginCode waits for that window to show a real session and captures
  // it under `userId`. See auth.ts for the full mechanism + why.
  needsLogin: (userId) => !isLoggedIn(userId),
  sendLoginCode: async (phone) => authSendLoginCode(phone, currentCity().slug),
  verifyLoginCode: async (userId, phone, code) => authVerifyLoginCode(userId, phone, code),
  tools: {
    // The reference "cracked the API" tool: real UC catalog search.
    search_catalog: async ({ query }, ctx) => {
      const services = extractServices(await searchServices(query))
      remember(ctx.sessionId, services)
      if (services.length === 0) return { error: `No services matched "${query}" — try a broader term (e.g. "cleaning").` }
      // Hand the agent what it needs to pick a service to book (pass its id to
      // select_slot). Prices carry `startsAt` so it won't misreport a "from" floor.
      return services.map(({ id, name, category, price, startsAt, rating }) => ({ id, name, category, price, startsAt, rating }))
    },

    // Select the service to book (by id from search) and pull its earliest
    // availability. In guest mode this is the booking-ready selection; the exact
    // slot grid is chosen by the human at the CAPTCHA-gated checkout.
    select_slot: async ({ slotId, address }, ctx) => {
      const svc = searchCache.get(ctx.sessionId)?.get(slotId)
      if (!svc) return { error: `unknown service ${slotId} — search first and use an id from the results` }
      let earliestSlot: string | undefined
      try {
        const category = await fetchCategory(deepLink(svc.categoryKey))
        earliestSlot = category ? extractEarliestSlot(category) : undefined
      } catch {
        /* best-effort — the deep link handoff works without the preview */
      }
      bookings.set(ctx.sessionId, {
        id: svc.id,
        name: svc.name,
        category: svc.category,
        price: svc.price,
        startsAt: svc.startsAt,
        categoryKey: svc.categoryKey,
        addressOverride: address,
        earliestSlot,
      })
      return bookingState(ctx.sessionId)
    },

    get_state: async (_input, ctx) => bookingState(ctx.sessionId),

    // Crosses the EXECUTE gate (native tool approval). `needsLogin` above parks
    // the run for phone+OTP first, so by the time this runs we're either guest
    // (no session — booking-ready deep-link handoff, the original posture) or
    // authenticated. Authenticated + home-cleaning drives a REAL local Chrome
    // (browserDrive.ts) — injected with the captured session, on the user's own
    // machine — through the actual booking UI to a parked "Proceed to pay"
    // screen in one continuous session. This replaces an earlier headless-API +
    // resume-link design: UC's checkout has no resume-by-URL (a cold reopen of
    // journey/checkout?...&draftOrderId=... ignores the id and loads the stale
    // persistent cart with address/slot reset — verified live), so a link can
    // never hand off a finished draft. Driving the real, visible browser
    // sidesteps that entirely — the window itself is the handoff, and state
    // persists because the SPA is never left. SCOPE: home-cleaning only for
    // now — other categories' Add-modal shape differs (verified against AC
    // service) and needs its own pass; those fall back to the guest handoff.
    confirm: async (_input, ctx) => {
      const b = bookings.get(ctx.sessionId)
      if (!b) return { status: 'empty', ...bookingState(ctx.sessionId), note: 'Nothing selected to book.' }
      const state = bookingState(ctx.sessionId)
      bookings.delete(ctx.sessionId)
      searchCache.delete(ctx.sessionId)

      const auth = authFor(ctx.userId)
      if (auth && b.categoryKey === 'professional_home_cleaning') {
        try {
          // Default to the client's current city; if the user asked for
          // somewhere else, geocode THAT text instead (Nominatim — @/core/geocode)
          // rather than silently booking at the wrong place. A failed geocode
          // is a hard stop into the guest handoff, never a guess.
          let citySlug: string
          let cityKey: string
          let addressHint: string | undefined
          if (b.addressOverride) {
            const hit = await geocodeAddress(b.addressOverride)
            if (!hit) {
              return {
                status: 'booking-ready',
                ...state,
                note: `Couldn't find "${b.addressOverride}" — open the link, sign in, and enter that address there. Nothing charged.`,
              }
            }
            const metro = nearestMetroFor(hit.lat, hit.lon)
            if (!metro.serviceable) {
              return {
                status: 'booking-ready',
                ...state,
                note: `"${b.addressOverride}" resolved to ${hit.formattedAddress}, which is too far from any serviceable city — open the link to check availability there yourself. Nothing charged.`,
              }
            }
            citySlug = metro.slug
            cityKey = metro.cityKey
            addressHint = b.addressOverride
          } else {
            ;({ slug: citySlug, cityKey } = currentCity())
          }
          const result = await driveToPay({
            citySlug,
            cityKey,
            categoryKey: b.categoryKey,
            packageName: b.name,
            addressHint,
            auth: { token: auth.token, ucUserId: auth.ucUserId, name: auth.name },
            screenshotDir: '.data/uc-drive-screenshots',
          })
          return {
            status: result.ok ? 'ready-to-pay' : 'booking-ready',
            ...state,
            checkoutUrl: null, // no shareable link — see the module doc; the driven window IS the handoff
            loggedInAs: auth.name,
            packageBooked: b.name,
            selectedSlot: result.slotLabel,
            amountToPay: result.amountToPay,
            note: result.ok
              ? `A real Chrome window just opened on this machine, signed in as ${auth.name ?? 'you'} — ${b.name}${result.slotLabel ? `, slot ${result.slotLabel}` : ''}${result.amountToPay ? `, ${result.amountToPay} to pay` : ''}. Just click "Proceed to pay" there. Nothing charged until you do.`
              : `${result.note} Open the Urban Company app to finish manually. Nothing charged.`,
          }
        } catch (e) {
          return {
            status: 'booking-ready',
            ...state,
            note: `Couldn't complete the authenticated booking (${e instanceof Error ? e.message : e}) — open the link to finish manually. Nothing charged.`,
          }
        }
      }
      return {
        status: 'booking-ready',
        ...state,
        note: 'Open the link to pick your exact slot, sign in (Urban Company requires a human login) and confirm. Nothing is charged until you do.',
      }
    },
  },
}

export { closeClient }
