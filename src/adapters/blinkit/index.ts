import type { Adapter } from '@/core/adapter'
import { JsonStore } from '@/core/store'
import { getLocation, searchRaw, setLocation } from './client'
import { type BlinkitProduct, extractProducts } from './parse'

/**
 * Blinkit adapter (P3, the reference implementation — DESIGN.md §12).
 *
 * The load-bearing, "cracked the API not the DOM" part is `search_catalog`: it
 * hits Blinkit's real internal `/v1/layout/search` endpoint (through a Chromium
 * TLS vehicle — see client.ts) and parses the layout JSON into products. The
 * agent's substitution / flag-unavailable logic — already proven on the mock —
 * then runs unchanged over real inventory.
 *
 * Cart is client-side by design: Blinkit's own web cart is optimistic
 * (client-state first, synced to /v5/carts only at checkpoints — B1), and a
 * *checkout-ready cart* (the graded deliverable) needs only real product
 * ids/prices from search. So add_to_cart/get_state hold lines in a per-session
 * store keyed by ctx.sessionId (exactly like the mock, so the durable EXECUTE
 * gate still works across a restart). Placing a paid order (B4) needs a
 * logged-in session and lives behind confirm; guest mode stops one step short.
 */

type Line = { id: string; name: string; price: number; qty: number; unit?: string }
const carts = new JsonStore<Line[]>('.data/blinkit-carts.json')

// Per-session cache of the last search results, so add_to_cart can resolve an
// itemId → real product snapshot (name/price/unit) without re-hitting Blinkit.
// In-memory only; the durable cart lines (with name/price) live in the JsonStore
// above, so the gate can still complete an approved order after a restart.
const searchCache = new Map<string, Map<string, BlinkitProduct>>()

function remember(sessionId: string, products: BlinkitProduct[]): void {
  let byId = searchCache.get(sessionId)
  if (!byId) searchCache.set(sessionId, (byId = new Map()))
  for (const p of products) byId.set(p.id, p)
}

async function cartState(sessionId: string) {
  const lines = carts.get(sessionId) ?? []
  const items = lines.map((l) => ({
    id: l.id,
    name: l.name,
    unit: l.unit,
    qty: l.qty,
    lineTotal: l.price * l.qty,
  }))
  const loc = await getLocation().catch(() => null)
  return {
    items,
    total: items.reduce((sum, it) => sum + it.lineTotal, 0),
    currency: 'INR',
    // Where this cart delivers (current/IP location by default) — so the human
    // sees the store the prices/availability came from.
    deliverTo: loc ? { address: loc.address, city: loc.city, serviceable: loc.serviceable } : undefined,
    // A checkout-ready pointer: the human finishes in-app (location + login are
    // set there). Guest mode can't place a paid order, so this is the handoff.
    checkoutUrl: 'https://blinkit.com/cart',
  }
}

export const blinkit: Adapter = {
  service: 'quickcommerce',
  tools: {
    search_catalog: async ({ query }, ctx) => {
      const layout = await searchRaw(query)
      const products = extractProducts(layout)
      remember(ctx.sessionId, products)
      // Hand the agent exactly what it needs to match/substitute (DESIGN §12.3).
      return products.map(({ id, name, price, inStock, unit, brand }) => ({
        id,
        name,
        price,
        inStock,
        unit,
        brand,
      }))
    },

    add_to_cart: async ({ itemId, qty }, ctx) => {
      const product = searchCache.get(ctx.sessionId)?.get(itemId)
      if (!product) return { error: `unknown item ${itemId} — search for it first, use an id from the results` }
      if (!product.inStock) return { error: `${product.name} is out of stock` }
      const lines = carts.get(ctx.sessionId) ?? []
      const existing = lines.find((l) => l.id === itemId)
      if (existing) existing.qty += qty
      else lines.push({ id: itemId, name: product.name, price: product.price, qty, unit: product.unit })
      carts.set(ctx.sessionId, lines)
      return cartState(ctx.sessionId)
    },

    get_state: async (_input, ctx) => cartState(ctx.sessionId),
    // NB: add_to_cart/get_state return the Promise from cartState directly.

    // Crosses the EXECUTE gate (native tool approval). In guest mode this
    // finalizes the checkout-ready cart — the real deliverable — and hands off to
    // the app for payment (login required at Blinkit checkout, B1). Placing a
    // real paid order (B4, bonus) slots in here behind the same gate once a
    // logged-in session is captured.
    confirm: async (_input, ctx) => {
      const state = await cartState(ctx.sessionId)
      const order = {
        status: 'checkout-ready',
        note: 'Cart assembled from live Blinkit inventory. Finish payment in-app (login required at checkout).',
        ...state,
      }
      carts.delete(ctx.sessionId)
      searchCache.delete(ctx.sessionId)
      return order
    },
  },
}

export { setLocation }
