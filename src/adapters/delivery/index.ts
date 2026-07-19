import { existsSync } from 'node:fs'
import type { Adapter, ToolCtx } from '@/core/adapter'
import type { AgentEvent } from '@/core/events'
import type { Intent } from '@/core/intent'
import { JsonStore } from '@/core/store'
import { book, cancel as clientCancel, closeClient, deepLink, isLoggedIn, quote, resolve, startLogin, track } from './client'
import type { UberLocation, UberProduct } from './parse'

// Trip states where a driver/ride is live (tracking continues; "done" leaves this).
const ACTIVE = new Set(['Dispatching', 'WaitingForPickup', 'Matched', 'EnRoute', 'Arriving', 'Arrived', 'OnTrip'])

/**
 * observe() — after a real dispatch, poll GetStatus and stream the live trip to
 * the UI: a `state_update` card every poll (driver, vehicle, ETA, driver location,
 * distance-to-pickup, PIN) plus a chat line when the driver is assigned or the
 * status changes. Ends when the trip leaves the active set (arrived/completed) or
 * the caller stops iterating (on cancel). Fields per scratchpad/uber-capture.md.
 */
async function* observeTrip(_intent: Intent, ctx: ToolCtx): AsyncIterable<AgentEvent> {
  const user = profileKey(ctx.userId)
  let lastDriver: string | undefined
  for (let i = 0; i < 150; i++) {
    let s: Awaited<ReturnType<typeof track>>[number] | undefined
    try {
      const snaps = await track(user, { durationMs: 5000, intervalMs: 4000 })
      s = snaps[snaps.length - 1]
    } catch {
      /* transient — keep polling */
    }
    if (!s) continue
    yield {
      type: 'state_update',
      state: {
        tracking: {
          status: s.status,
          driver: s.driver,
          rating: s.driverRating,
          vehicle: s.vehicle,
          plate: s.plate,
          etaText: s.etaText,
          driverLat: s.driverLat,
          driverLng: s.driverLng,
          distanceToPickupM: s.distanceToPickupM,
          pin: s.pin,
          fare: s.fare,
        },
      },
    }
    // One-time chat notification when a driver is assigned; the live card (updated
    // in place) carries the moment-to-moment status/ETA/location, so we don't emit
    // a bubble per poll or per status change.
    if (s.driver && s.driver !== lastDriver) {
      lastDriver = s.driver
      yield {
        type: 'agent_message',
        text: `🧑‍✈️ Driver assigned: ${s.driver}${s.driverRating ? ` ★${s.driverRating}` : ''} — ${s.vehicle ?? 'vehicle'}${s.plate ? ` (${s.plate})` : ''}. PIN ${s.pin ?? '—'}.${s.etaText ? ` ${s.etaText}` : ''}${s.distanceToPickupM != null ? `, ~${s.distanceToPickupM} m away` : ''}`,
      }
    }
    if (s.status && !ACTIVE.has(s.status)) {
      yield { type: 'agent_message', text: `Ride ${s.status.toLowerCase()}.` }
      return
    }
  }
}

/**
 * Hyperlocal Delivery adapter (P1, Uber — DESIGN.md §7, §10; capture in
 * scratchpad/uber-capture.md). A third, different-shaped target: a point-to-point
 * ride, not a cart (Blinkit) or a slot (UC). Like Blinkit it's a "cracked the API
 * not the DOM" typed client — Uber's web app is a clean same-origin JSON API, so
 * NO agent/DOM driver is needed (unlike UC): resolve/quote/book/track are real
 * endpoints (pudoLocationSearch, getPlaceDetails, Products, TripRequest, GetStatus).
 *
 * Two tiers:
 *  A (guest, no login): resolve pickup+drop → a booking-ready deep link (the
 *    analogue of Blinkit's shared-cart link). Always available.
 *  B (the "linked account", logged in): live fares (request_quote) and a real
 *    booking behind the EXECUTE gate (confirm → TripRequest, the money line).
 *  Login is a one-time HUMAN step (Google/OTP) captured into a persistent browser
 *  profile; automation only rides the session (see client.ts / needsLogin).
 *
 * The money line (dispatching a real ride to a real driver) is P1's most cautious
 * action (DESIGN §5): confirm crosses it only after explicit approval, once.
 */

interface Trip {
  pickup: UberLocation
  drop: UberLocation
  options: UberProduct[]
  selectedVvid?: string
  loggedIn: boolean
}
const trips = new JsonStore<Trip>('.data/uber-trips.json')

// Sync login flag (needsLogin must be sync). Set true after a verified login;
// the real session validity is re-checked async at quote/confirm time.
const loginFlags = new JsonStore<{ ok: boolean }>('.data/uber-login.json')

// MULTI-USER: each user logs into their OWN Uber account, and their session
// persists in a browser profile keyed by their userId (exactly like Blinkit B4 /
// UC per-user login). So yes — it asks each new user to sign in once, then reuses
// their session. `UBER_USER` is an optional single-tenant override (testing / a
// personal deployment) that pins everyone to one profile; unset = per-user.
// NB: the WEB client must send an authenticated per-user `userId` for true
// multi-user (else all anon users share the 'anon' profile); the CLI already does
// via FAFF_USER_ID.
const profileKey = (userId: string): string => process.env.UBER_USER || userId
// Cheap sync "already logged in?" check: this user's profile has a cookie DB from
// a prior login. A false positive (expired session) degrades gracefully —
// request_quote re-checks live and falls back to the Tier-A deep link.
function profileHasSession(userId: string): boolean {
  const root = process.env.UBER_PROFILE_DIR ?? '.data/uber-profiles'
  return existsSync(`${root}/${profileKey(userId).replace(/[^a-zA-Z0-9_-]/g, '_')}/Default/Cookies`)
}

function optionView(p: UberProduct) {
  return { id: p.vvid, name: p.displayName, fare: p.fare, fareValue: p.fareValue, currency: p.currency, etaInMin: p.etaInMin, seats: p.capacity, description: p.description }
}

function tripState(sessionId: string) {
  const t = trips.get(sessionId)
  if (!t) return { ready: false, note: 'No trip yet — give me a pickup and a drop.' }
  const selected = t.selectedVvid ? t.options.find((o) => o.vvid === t.selectedVvid) : undefined
  return {
    ready: true,
    pickup: { title: t.pickup.title, address: t.pickup.fullAddress ?? t.pickup.addressLine1 },
    drop: { title: t.drop.title, address: t.drop.fullAddress ?? t.drop.addressLine1 },
    options: t.options.map(optionView),
    selected: selected ? optionView(selected) : undefined,
    loggedIn: t.loggedIn,
    // The Tier-A handoff is always available: a link that opens Uber pre-filled.
    bookingLink: deepLink(t.pickup, t.drop, t.selectedVvid),
    note: t.loggedIn
      ? 'Pick a ride, then say "book" to request it — a real ride is dispatched only after you approve, nothing before.'
      : 'Live fares & one-tap booking need you signed in (say "login"). Until then, the link above opens Uber with this trip pre-filled.',
  }
}

export const delivery: Adapter = {
  service: 'delivery',

  // Live tracking (after a real dispatch) + the post-dispatch kill path.
  observe: observeTrip,
  cancel: (ctx) => clientCancel(profileKey(ctx.userId)),

  // Per-user account login = the "linked account". We never automate the OTP or
  // Google OAuth — startLogin opens the user's own browser profile at Uber's
  // login; the human signs in there once; the session persists in the profile.
  needsLogin: (userId) => !(loginFlags.get(profileKey(userId))?.ok ?? false) && !profileHasSession(userId),
  sendLoginCode: async (_phone, userId) => {
    // Opens THIS user's Uber profile login window. The human signs in (phone-OTP),
    // then replies to continue. We never automate the OTP.
    await startLogin(profileKey(userId ?? ''))
    return {
      ok: true,
      instructions:
        'A browser window just opened on Uber’s sign-in page. Sign in with your PHONE NUMBER + OTP — I won’t touch it. (Heads-up: “Continue with Google” is blocked by Google inside an automated browser — a wall we don’t bypass — so use the phone-OTP option even if your account is a Google one.) When you’re back on a logged-in Uber page, reply with any text to continue. Nothing is charged.',
    }
  },
  verifyLoginCode: async (userId) => {
    const key = profileKey(userId)
    const ok = await isLoggedIn(key).catch(() => false)
    if (ok) {
      loginFlags.set(key, { ok: true })
      return { ok: true }
    }
    return { ok: false, error: 'Not signed in yet — finish the login in the open window, then try again.' }
  },

  tools: {
    // Resolve a single free-text address → a concrete Uber place (utility /
    // disambiguation). Returns null-safe: never guesses (a wrong location = a
    // real driver to the wrong door).
    resolve_location: async ({ text }, ctx) => {
      const loc = await resolve(profileKey(ctx.userId), text, 'PICKUP')
      if (!loc) return { error: `Couldn't find "${text}" — try a more specific address.` }
      return { title: loc.title, address: loc.fullAddress ?? loc.addressLine1, lat: loc.latitude, lon: loc.longitude }
    },

    // The core tool: resolve pickup + drop, build the booking-ready link, and (if
    // signed in) pull live fares for each ride option.
    request_quote: async ({ pickup, drop }, ctx) => {
      const user = profileKey(ctx.userId)
      const [p, d] = await Promise.all([resolve(user, pickup, 'PICKUP'), resolve(user, drop, 'DROPOFF')])
      if (!p) return { error: `Couldn't find the pickup "${pickup}" — try a more specific address.` }
      if (!d) return { error: `Couldn't find the drop "${drop}" — try a more specific address.` }

      let options: UberProduct[] = []
      let loggedIn = false
      try {
        const q = await quote(user, p, d)
        loggedIn = q.loggedIn
        options = q.products
      } catch {
        /* fares are best-effort; the deep-link handoff works regardless */
      }
      trips.set(ctx.sessionId, { pickup: p, drop: d, options, loggedIn })
      return tripState(ctx.sessionId)
    },

    // Choose a ride option (by vehicleViewId from request_quote, or by name).
    select_slot: async ({ slotId }, ctx) => {
      const t = trips.get(ctx.sessionId)
      if (!t) return { error: 'No trip yet — give me a pickup and drop first.' }
      const match = t.options.find((o) => o.vvid === slotId) ?? t.options.find((o) => o.displayName.toLowerCase() === String(slotId).toLowerCase())
      if (!match) return { error: `No ride option "${slotId}". Options: ${t.options.map((o) => o.displayName).join(', ') || '(none — sign in for live options)'}` }
      t.selectedVvid = match.vvid
      trips.set(ctx.sessionId, t)
      return tripState(ctx.sessionId)
    },

    get_state: async (_input, ctx) => tripState(ctx.sessionId),

    // Crosses the EXECUTE gate (native tool approval) — the ONLY path that can
    // dispatch a real ride (real money, a real driver: P1's most cautious action).
    // Signed in + a ride selected → book it (TripRequest). Otherwise hand off the
    // pre-filled deep link (guest), one step short of dispatch — like Blinkit.
    confirm: async (_input, ctx) => {
      const t = trips.get(ctx.sessionId)
      if (!t) return { status: 'empty', ...tripState(ctx.sessionId), note: 'Nothing to book — give me a pickup and drop.' }
      const state = tripState(ctx.sessionId)

      const user = profileKey(ctx.userId)
      const signedIn = t.loggedIn && (await isLoggedIn(user).catch(() => false))
      if (!signedIn || !t.selectedVvid) {
        // Guest / no-selection handoff: the deep link IS the booking-ready
        // deliverable. Nothing dispatched, nothing charged.
        return {
          status: 'booking-ready',
          ...state,
          note: t.selectedVvid
            ? 'Sign in to dispatch this automatically. For now, open the link to book & pay in Uber — nothing is charged until you do.'
            : 'Open the link to choose a ride and book in Uber — nothing is charged until you do.',
        }
      }

      // Signed in + a ride chosen: dispatch it for real (post-approval, once).
      try {
        const r = await book(user, t.pickup, t.drop, t.selectedVvid)
        trips.delete(ctx.sessionId)
        if (!r.dispatched) {
          return { status: 'not-dispatched', ...state, note: `Couldn't dispatch the ride (${r.note}) — nothing charged.` }
        }
        return {
          status: 'dispatched',
          ...state,
          tripId: r.tripId,
          note: `Ride requested — ${state.selected?.name ?? 'your ride'}, ${state.selected?.fare ?? ''}. I'll track the driver from here. Say "cancel" to call it off.`,
        }
      } catch (e) {
        return { status: 'not-dispatched', ...state, note: `Couldn't dispatch the ride (${e instanceof Error ? e.message : e}) — nothing charged.` }
      }
    },
  },
}

export { closeClient }
