/**
 * Parse Urban Company's `discoverySearch` response (server-driven-UI) into flat
 * services. Results live at `dataStore.searchResultsCard.items[]`; each is a
 * `list` widget whose `textStack` carries the title + a "★ rating • ₹price •
 * category" caption, and whose `tapAction.metaData` carries the ids we key on.
 * (Reverse-engineered live — see the uc-capture-findings memory / scripts/uc-probe*.)
 */

export interface UCService {
  /** searchResultId — stable id the agent passes back to select the service. */
  id: string
  /** UC category key (e.g. "professional_home_cleaning") — drives the deep link. */
  categoryKey: string
  /** Clean package title, e.g. "Furnished apartment - Home deep cleaning". */
  name: string
  /** Category label from the caption, e.g. "Full Home/ By Room Cleaning". */
  category: string
  /** Price in INR. When `startsAt`, it's a "from" floor (options priced higher). */
  price: number
  startsAt: boolean
  rating?: number
  ratingCount?: string
  /** deeplink sectionId, if present. */
  sectionId?: string
}

// biome-ignore lint/suspicious/noExplicitAny: server-driven-UI tree, typed loosely
type Any = any

/** Strip UC's search-highlight markup: `{ ``deep`` <textType:body-b/> }` → `deep`. */
function cleanLabel(s: string): string {
  return s
    .replace(/\{\s*`([^`]*)`\s*<[^>]*?>\s*\}/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[`{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "★ 4.80 (683K)  •  ₹3,499  •  Full Home/ By Room Cleaning" (or "Starts at ₹549"). */
function parseCaption(caption: string): { price: number; startsAt: boolean; rating?: number; ratingCount?: string; category: string } {
  const parts = caption.split('•').map((p) => p.trim())
  const rm = parts[0]?.match(/([\d.]+)\s*\(([^)]+)\)/)
  const pm = caption.match(/₹\s*([\d,]+)/)
  return {
    rating: rm ? Number(rm[1]) : undefined,
    ratingCount: rm ? rm[2] : undefined,
    startsAt: /starts at/i.test(caption),
    price: pm ? Number(pm[1].replace(/,/g, '')) : 0,
    category: parts.length ? parts[parts.length - 1] : '',
  }
}

/** Pull the "Earliest" availability preview off a category page (initiateSeoJourney).
 * UC renders it as a text widget whose value is a day+time like "Fri, 8:00 AM".
 * Guest-visible; the full selectable slot grid is behind the (CAPTCHA-walled)
 * checkout, so this preview is the best availability signal we can surface. */
export function extractEarliestSlot(categoryJson: unknown): string | undefined {
  const DAYTIME = /^(mon|tue|wed|thu|fri|sat|sun|today|tomorrow)[a-z]*,?\s*\d{1,2}:\d{2}\s*[ap]m$/i
  let found: string | undefined
  const walk = (o: Any) => {
    if (found || !o || typeof o !== 'object') return
    for (const [k, v] of Object.entries(o)) {
      if (found) return
      if (k === 'textValue' && typeof v === 'string' && DAYTIME.test(v.trim())) {
        found = v.trim()
        return
      }
      walk(v)
    }
  }
  walk(categoryJson)
  return found
}

export function extractServices(searchJson: unknown, limit = 20): UCService[] {
  const items: Any[] = (searchJson as Any)?.success?.data?.dataStore?.searchResultsCard?.items ?? []
  const out: UCService[] = []
  const seen = new Set<string>()
  for (const it of items) {
    const d = it?.data
    const tap = d?.tapAction
    if (tap?.type !== 'SEARCH_RESULT_PRESSED') continue
    const meta = tap?.data?.metaData
    // Accept both `service_package` (a specific bookable service) and `category`
    // (a category the human picks into) — UC returns either depending on city/query,
    // and both carry the categoryKey + name + price we need for a booking handoff.
    const rtype = meta?.searchResultType
    if (rtype !== 'service_package' && rtype !== 'category') continue
    const categoryKey = String(meta.categoryKey ?? tap.data?.initiateJourney?.params?.dimensions?.categoryKey ?? '')
    const id = String(meta.searchResultId ?? categoryKey ?? meta.esDocId ?? '')
    if (!id || !categoryKey || seen.has(id)) continue
    seen.add(id)
    const stack: Any[] = d?.textStack?.items ?? []
    const label = stack.find((s) => s?.type === 'label_value')?.data?.labelText ?? ''
    const caption = stack.find((s) => s?.type === 'caption')?.data?.text ?? ''
    const c = parseCaption(caption)
    // Skip price-less `category` navigations (they'd show ₹0 and aren't a
    // bookable service) — keep specific service_packages and priced categories.
    if (rtype === 'category' && !c.price) continue
    out.push({
      id,
      categoryKey,
      name: cleanLabel(label) || c.category,
      category: c.category,
      price: c.price,
      startsAt: c.startsAt,
      rating: c.rating,
      ratingCount: c.ratingCount,
      sectionId: tap.data?.initiateJourney?.params?.deeplinkParams?.sectionId,
    })
    if (out.length >= limit) break
  }
  return out
}
