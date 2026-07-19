import type { Adapter } from '@/core/adapter'
import { geocodeAddress } from '@/core/geocode'
import { JsonStore } from '@/core/store'
import { authFor, isLoggedIn, sendLoginCode as authSendLoginCode, verifyLoginCode as authVerifyLoginCode } from './auth'
import { driveToPay } from './agentDrive'
import { closeClient, currentCity, currentCoords, deepLink, fetchCategory, hasLocation, nearestMetroFor, searchServices, setCoords } from './client'
import { type UCService, extractEarliestSlot, extractServices } from './parse'

/**
 * Home Services adapter (P2, Urban Company — DESIGN.md §7, §14, §14.7).
 *
 * Validates the harness abstraction on a *different-shaped* target than Blinkit:
 * slots/availability, not a cart. The load-bearing "cracked the API not the DOM"
 * part is `search_catalog` → UC's real `discoverySearch` endpoint (through the
 * Chromium TLS vehicle — see client.ts), parsed into services.
 *
 * ONE authenticated flow for ANY category (§14.7): the harness forces a per-user
 * login before `confirm` (session.ts gate → `needsLogin`; UC's Cloudflare
 * Turnstile only rejects *scripted* OTP, so the human clears it once in their own
 * Chrome and auth.ts captures the session under their `userId`), then `confirm`
 * drives a REAL local Chrome — that user's session injected — through the actual
 * booking UI to a parked "Proceed to pay" screen, stopping one call short of
 * payment. The drive is category-agnostic: an LLM reads the live DOM via
 * Playwright-MCP (agentDrive.ts) instead of hand-coded per-category selectors.
 * There is no no-login/guest path; availability is a three-tier funnel (city in
 * range → service offered in city via the `bookable` discriminator → address/slot
 * serviceability surfaced by the drive), and every miss reports plainly with no
 * link — never a wrong booking, nothing charged until the human clicks pay.
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
    // No deep-link handoff (§14.7 retired the guest path): booking happens by
    // driving the user's own logged-in browser at `confirm`. Nothing is charged
    // until the human clicks pay in that window.
    note: 'Selected. Say "book" to place it under your account (you\'ll sign in once if needed) — nothing is charged until the final step.',
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
      // Tier-2 availability: distinguish "rephrase" (nothing matched) from "not
      // offered in this city" (results came back, but only coarse category tiles,
      // nothing directly bookable — see parse.ts `bookable`).
      if (services.length === 0) return { error: `No services matched "${query}" — try a broader term (e.g. "cleaning").` }
      if (!services.some((s) => s.bookable)) {
        return { error: `Urban Company may not offer "${query}" in ${currentCity().label} — only general category links came back, nothing directly bookable here.` }
      }
      // Hand the agent what it needs to pick a service to book (pass its id to
      // select_slot). Prices carry `startsAt` so it won't misreport a "from" floor;
      // `bookable` lets it prefer a specific service over a category tile.
      return services.map(({ id, name, category, price, startsAt, rating, bookable }) => ({ id, name, category, price, startsAt, rating, bookable }))
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

    // Crosses the EXECUTE gate (native tool approval). The harness forces a
    // per-user login BEFORE this runs (session.ts gate → `needsLogin`), so `auth`
    // is present for the acting user. We then drive a REAL local Chrome — that
    // user's captured session injected — through the actual booking UI to a
    // parked "Proceed to pay" screen (agentDrive.ts, category-agnostic: an LLM
    // reads the live DOM rather than hand-coded selectors, so ANY category books).
    // Single flow: no guest/deep-link handoff. Any availability miss (address not
    // serviceable, no slots) or drive failure is reported plainly with NO link —
    // never a wrong booking, nothing charged until the human clicks pay.
    confirm: async (_input, ctx) => {
      const b = bookings.get(ctx.sessionId)
      if (!b) return { status: 'empty', ...bookingState(ctx.sessionId), note: 'Nothing selected to book.' }
      const state = bookingState(ctx.sessionId)
      bookings.delete(ctx.sessionId)
      searchCache.delete(ctx.sessionId)

      const auth = authFor(ctx.userId)
      // The login gate should have captured a per-user session already. If we're
      // somehow here without one, ask them to sign in — never a no-login handoff.
      if (!auth) {
        return { status: 'needs-login', ...state, checkoutUrl: null, note: 'Sign in to Urban Company to book this — say "login" to start. Nothing is charged.' }
      }

      try {
        // Default to the client's current city; if the user asked for somewhere
        // else, geocode THAT text (Nominatim — @/core/geocode) rather than book at
        // the wrong place. A failed/too-far geocode is a hard stop, reported plainly.
        let citySlug: string
        let cityKey: string
        let addressHint: string | undefined
        if (b.addressOverride) {
          const hit = await geocodeAddress(b.addressOverride)
          if (!hit) {
            return { status: 'unavailable', ...state, checkoutUrl: null, note: `Couldn't find "${b.addressOverride}" — nothing booked, nothing charged.` }
          }
          const metro = nearestMetroFor(hit.lat, hit.lon)
          if (!metro.serviceable) {
            return { status: 'unavailable', ...state, checkoutUrl: null, note: `"${b.addressOverride}" (${hit.formattedAddress}) is outside Urban Company's serviceable cities — nothing booked, nothing charged.` }
          }
          citySlug = metro.slug
          cityKey = metro.cityKey
          addressHint = b.addressOverride
        } else {
          ;({ slug: citySlug, cityKey } = currentCity())
          // No city switch, but the user may have set a custom delivery address
          // (UI bar / session) — pass it as the hint so the driver picks the RIGHT
          // saved address when several exist (e.g. two "Home" addresses).
          addressHint = ctx.deliveryAddress
        }

        const r = await driveToPay({
          citySlug,
          cityKey,
          categoryKey: b.categoryKey,
          packageName: b.name,
          addressHint,
          auth: { token: auth.token, ucUserId: auth.ucUserId, name: auth.name },
          screenshotDir: '.data/uc-drive-screenshots',
        })

        // Tier-3 availability, surfaced by the drive itself.
        if (!r.serviceableAtAddress || r.noSlots) {
          return {
            status: 'unavailable',
            ...state,
            checkoutUrl: null,
            loggedInAs: auth.name,
            note: `${r.noSlots ? 'No open slots came up for that service at your address' : 'That address is outside the serviceable area'} — nothing booked, nothing charged.`,
          }
        }
        const ok = r.reachedPay && r.slotSelected && r.payEnabled
        if (!ok) {
          return {
            status: 'unavailable',
            ...state,
            checkoutUrl: null,
            loggedInAs: auth.name,
            note: `Couldn't complete the booking automatically (${r.note}) — nothing charged.`,
          }
        }
        return {
          status: 'ready-to-pay',
          ...state,
          checkoutUrl: null, // the driven window IS the handoff — no shareable link
          loggedInAs: auth.name,
          packageBooked: b.name,
          selectedSlot: r.slotLabel,
          amountToPay: r.amountToPay,
          selectedAddress: r.selectedAddress,
          note: `A real Chrome window is open on this machine, signed in as ${auth.name ?? 'you'} — ${b.name}${r.slotLabel ? `, slot ${r.slotLabel}` : ''}${r.amountToPay ? `, ${r.amountToPay} to pay` : ''}${r.selectedAddress ? `, delivering to ${r.selectedAddress}` : ''}. ⚠️ Check the address is right, then click "Proceed to pay" there. Nothing charged until you do.`,
        }
      } catch (e) {
        return {
          status: 'unavailable',
          ...state,
          checkoutUrl: null,
          note: `Couldn't complete the booking (${e instanceof Error ? e.message : e}) — nothing charged.`,
        }
      }
    },
  },
}

export { closeClient }
