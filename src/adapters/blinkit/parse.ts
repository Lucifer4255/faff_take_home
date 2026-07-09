import { z } from 'zod'

/**
 * Blinkit search is a *layout* endpoint (`/v1/layout/search`) — it returns UI
 * widget blocks (carousels, grids, ad slots), not a flat product list, and the
 * same product recurs across several widgets. Rather than hard-code a fragile
 * widget path (which Blinkit reshuffles), we walk the tree and collect every
 * node that IS a product, then dedupe by product_id.
 *
 * Shape below is ⟨capture⟩'d from a live guest search (scripts/blinkit-probe.ts,
 * DESIGN.md §12.1) — the flat product node embedded in the layout:
 *   { product_id, merchant_id, product_name, display_name, price, mrp, unit,
 *     inventory, unavailable_quantity, brand, image_url, group_id, ... }
 */
const ProductNode = z.object({
  product_id: z.union([z.number(), z.string()]),
  product_name: z.string().optional(),
  display_name: z.string().optional(),
  price: z.number(),
  mrp: z.number().optional(),
  unit: z.string().optional(),
  inventory: z.number().optional(),
  brand: z.string().optional(),
  merchant_id: z.union([z.number(), z.string()]).optional(),
  image_url: z.string().optional(),
})

/** Our internal, adapter-agnostic product — what search_catalog hands the agent.
 * `inStock` is the only field the substitution/unavailable logic keys on; the
 * rest carry through to the cart so a line has a real name/price/unit. */
export interface BlinkitProduct {
  id: string
  name: string
  price: number
  mrp?: number
  inStock: boolean
  unit?: string
  brand?: string
  merchantId?: string
  imageUrl?: string
}

function isProductNode(value: unknown): value is z.infer<typeof ProductNode> {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  // Cheap pre-check before Zod so we don't validate every object in a 200KB tree.
  return 'product_id' in v && 'price' in v && ('product_name' in v || 'display_name' in v)
}

function toProduct(node: z.infer<typeof ProductNode>): BlinkitProduct {
  const name = node.product_name ?? node.display_name ?? `#${node.product_id}`
  return {
    id: String(node.product_id),
    name,
    price: node.price,
    mrp: node.mrp,
    // inventory absent → assume orderable (search only surfaces buyable SKUs);
    // inventory present → 0 means out of stock at this dark store.
    inStock: node.inventory === undefined ? true : node.inventory > 0,
    unit: node.unit,
    brand: node.brand,
    merchantId: node.merchant_id !== undefined ? String(node.merchant_id) : undefined,
    imageUrl: node.image_url,
  }
}

/**
 * Recursively collect products from a Blinkit layout response, deduped by
 * product_id (first occurrence wins — earlier widgets are the direct search
 * hits; later ones are recommendations/ads). `limit` caps what we hand the LLM.
 */
export function extractProducts(layout: unknown, limit = 20): BlinkitProduct[] {
  const byId = new Map<string, BlinkitProduct>()
  const stack: unknown[] = [layout]
  while (stack.length) {
    const cur = stack.pop()
    if (Array.isArray(cur)) {
      // preserve document order for the dedupe "first wins" rule
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i])
      continue
    }
    if (cur && typeof cur === 'object') {
      if (isProductNode(cur)) {
        const parsed = ProductNode.safeParse(cur)
        if (parsed.success) {
          const p = toProduct(parsed.data)
          if (!byId.has(p.id)) byId.set(p.id, p)
        }
      }
      // descend regardless — a product node may nest child widgets we ignore,
      // and non-product containers hold the products we want.
      for (const val of Object.values(cur as Record<string, unknown>)) {
        if (val && typeof val === 'object') stack.push(val)
      }
    }
  }
  return [...byId.values()].slice(0, limit)
}
