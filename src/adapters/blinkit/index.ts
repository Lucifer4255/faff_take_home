import type { Adapter } from '@/core/adapter'

/**
 * Blinkit (P3) — reverse-engineered web/API first (DESIGN.md §7).
 * Capture the internal JSON endpoints (catalog search, product, cart), replay
 * with a typed HTTP client. The interesting logic: SKU matching with
 * reasonable-alternative / flag-unavailable. Stub until B1 capture.
 */
export const blinkit: Adapter = {
  service: 'quickcommerce',
  tools: {
    search_catalog: async ({ query }) => {
      throw new Error(`TODO(B1): capture Blinkit catalog-search endpoint (query=${query})`)
    },
    add_to_cart: async ({ itemId, qty }) => {
      throw new Error(`TODO(B3): capture Blinkit cart endpoint (${itemId} x${qty})`)
    },
    get_state: async () => {
      throw new Error('TODO(B3): read current cart state')
    },
    confirm: async ({ summary }) => {
      throw new Error(`TODO(B4, bonus): place order behind EXECUTE gate (${summary})`)
    },
  },
}
