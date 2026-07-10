import type { Adapter } from '@/core/adapter'
import { JsonStore } from '@/core/store'
import { closeClient, currentCity, deepLink, fetchCategory, hasLocation, searchServices, setCoords } from './client'
import { type UCService, extractEarliestSlot, extractServices } from './parse'

/**
 * Home Services adapter (P2, Urban Company — DESIGN.md §7, §14).
 *
 * Validates the harness abstraction on a *different-shaped* target than Blinkit:
 * slots/availability, not a cart. The load-bearing "cracked the API not the DOM"
 * part is `search_catalog` → UC's real `discoverySearch` endpoint (through the
 * Chromium TLS vehicle — see client.ts), parsed into services.
 *
 * GUEST, no spend. UC login is walled by a Cloudflare Turnstile CAPTCHA that
 * rejects automated browsers, so the selectable slot-grid + booking sit past a
 * wall we don't cross. The adapter reaches a **booking-ready handoff**: the
 * chosen service + price + earliest availability + a deep link; the human opens
 * the link and finishes (login + exact slot + pay) in-app. This mirrors Blinkit's
 * guest checkout-ready cart (B1–B3), with the final step honestly documented as
 * CAPTCHA-gated (see the uc-capture-findings memory).
 */

interface Booking {
  id: string
  name: string
  category: string
  price: number
  startsAt: boolean
  categoryKey: string
  earliestSlot?: string
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
    select_slot: async ({ slotId }, ctx) => {
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
        earliestSlot,
      })
      return bookingState(ctx.sessionId)
    },

    get_state: async (_input, ctx) => bookingState(ctx.sessionId),

    // Crosses the EXECUTE gate (native tool approval). Guest mode can't place a
    // real booking (login is CAPTCHA-walled), so this finalizes the booking-ready
    // handoff — the deep link the human opens to pick the slot, sign in and pay.
    confirm: async (_input, ctx) => {
      const b = bookings.get(ctx.sessionId)
      if (!b) return { status: 'empty', ...bookingState(ctx.sessionId), note: 'Nothing selected to book.' }
      const state = bookingState(ctx.sessionId)
      bookings.delete(ctx.sessionId)
      searchCache.delete(ctx.sessionId)
      return {
        status: 'booking-ready',
        ...state,
        note: 'Open the link to pick your exact slot, sign in (Urban Company requires a human login) and confirm. Nothing is charged until you do.',
      }
    },
  },
}

export { closeClient }
