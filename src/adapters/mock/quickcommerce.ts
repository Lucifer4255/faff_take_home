import type { Adapter } from '@/core/adapter'
import { JsonStore } from '@/core/store'

/**
 * Mock quick-commerce adapter — exercises the full harness (search →
 * alternatives → cart → EXECUTE gate → order) with zero real-world calls.
 * Enable with MOCK_ADAPTERS=1. Deliberately includes out-of-stock items so the
 * agent's pick-alternative / flag-unavailable behaviour is testable.
 */
interface Product {
  id: string
  name: string
  price: number
  inStock: boolean
}

const CATALOG: Product[] = [
  { id: 'sku-milk-2l', name: 'Nandini Full Cream Milk 2L', price: 130, inStock: false },
  { id: 'sku-milk-1l', name: 'Nandini Full Cream Milk 1L', price: 66, inStock: true },
  { id: 'sku-milk-amul-1l', name: 'Amul Taaza Toned Milk 1L', price: 72, inStock: true },
  { id: 'sku-bread-white', name: 'Modern White Bread 400g', price: 45, inStock: true },
  { id: 'sku-bread-brown', name: 'Britannia Brown Bread 400g', price: 55, inStock: true },
  { id: 'sku-eggs-6', name: 'Farm Eggs 6pc', price: 54, inStock: true },
  { id: 'sku-butter-100', name: 'Amul Butter 100g', price: 62, inStock: false },
]

// Cart persisted per sessionId — models a real server-side cart (keyed by
// session token) and, crucially, survives a process restart so the durable
// EXECUTE gate can complete an order after the server is killed and rebooted.
type Line = { id: string; name: string; price: number; qty: number }
const carts = new JsonStore<Line[]>('.data/mock-carts.json')

function cartState(sessionId: string) {
  const lines = carts.get(sessionId) ?? []
  const items = lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, lineTotal: l.price * l.qty }))
  return { items, total: items.reduce((sum, item) => sum + item.lineTotal, 0), currency: 'INR' }
}

export const mockQuickcommerce: Adapter = {
  service: 'quickcommerce',
  tools: {
    search_catalog: async ({ query }) => {
      const words = query.toLowerCase().split(/\s+/)
      const hits = CATALOG.filter((p) => words.some((w) => p.name.toLowerCase().includes(w)))
      return hits.map(({ id, name, price, inStock }) => ({ id, name, price, inStock }))
    },
    add_to_cart: async ({ itemId, qty }, ctx) => {
      const product = CATALOG.find((p) => p.id === itemId)
      if (!product) return { error: `unknown item ${itemId}` }
      if (!product.inStock) return { error: `${product.name} is out of stock` }
      const lines = carts.get(ctx.sessionId) ?? []
      const existing = lines.find((l) => l.id === itemId)
      if (existing) existing.qty += qty
      else lines.push({ id: itemId, name: product.name, price: product.price, qty })
      carts.set(ctx.sessionId, lines)
      return cartState(ctx.sessionId)
    },
    get_state: async (_input, ctx) => cartState(ctx.sessionId),
    confirm: async (_input, ctx) => {
      const order = { orderId: `mock-${ctx.sessionId.slice(0, 8)}`, ...cartState(ctx.sessionId) }
      carts.delete(ctx.sessionId)
      return order
    },
  },
}
