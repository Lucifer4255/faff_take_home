import type { Adapter } from '@/core/adapter'

/**
 * Hyperlocal Delivery (P1) — API capture with browser-assisted auth (DESIGN.md §7).
 * Clear login/OTP once in a browser, persist the session, then hit booking +
 * trip-status endpoints. Rapido or Porter over Uber. Dispatching the ride is
 * the deliberate money-risk line: done once, last, cancel tested first.
 */
export const delivery: Adapter = {
  service: 'delivery',
  tools: {
    resolve_location: async ({ text }) => {
      throw new Error(`TODO(D3): geocode messy address (text=${text})`)
    },
    request_quote: async ({ pickup, drop }) => {
      throw new Error(`TODO(D4): quote endpoint (${pickup} -> ${drop})`)
    },
    get_state: async () => {
      throw new Error('TODO(D5): ride status endpoint')
    },
    confirm: async ({ summary }) => {
      throw new Error(`TODO(D6): dispatch ride behind EXECUTE gate, cancel path first (${summary})`)
    },
  },
  // TODO(D5): observe() — poll trip-status for live ride updates.
}
