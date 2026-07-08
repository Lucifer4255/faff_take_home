import type { Adapter } from '@/core/adapter'

/**
 * Home Services (P2) — hybrid, lean browser (DESIGN.md §7).
 * Drive Snabbit / Urban Company with Playwright to a booking-ready slot; sniff
 * the availability endpoint in parallel, promote to direct API if clean.
 */
export const homeservices: Adapter = {
  service: 'homeservices',
  tools: {
    search_catalog: async ({ query }) => {
      throw new Error(`TODO(H2): find matching service via app flow (query=${query})`)
    },
    select_slot: async ({ slotId }) => {
      throw new Error(`TODO(H3): reach booking-ready slot (slot=${slotId})`)
    },
    get_state: async () => {
      throw new Error('TODO(H3): read current slot/booking state')
    },
    confirm: async ({ summary }) => {
      throw new Error(`TODO(H4, bonus): book programmatically behind EXECUTE gate (${summary})`)
    },
  },
}
