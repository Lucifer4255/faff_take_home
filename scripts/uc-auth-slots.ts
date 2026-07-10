/**
 * Grind toward the real slot grid: replay the captured getCheckoutJourneySlotPage
 * against the user's persistent draft with the injected token, and parse the slot
 * structure out of the response. STOPS before payment (read-only slot fetch).
 *
 * Run: npx tsx scripts/uc-auth-slots.ts
 */
import { readFileSync } from 'node:fs'
import { apiPost, closeClient, setCoords } from '../src/adapters/homeservices/client'
import { importFromSession } from '../src/adapters/homeservices/auth'

// biome-ignore lint: captured payloads
type Any = any
function captured(urlRe: string): { body: Any; res: Any } {
  const m = JSON.parse(readFileSync('scratchpad/uc/booking/_manifest.json', 'utf8'))
  const i = m.find((c: { url: string }) => new RegExp(urlRe).test(c.url)).i
  const p = (suffix: string) => `scratchpad/uc/booking/${String(i).padStart(2, '0')}-${suffix}.json`
  return { body: JSON.parse(readFileSync(p('req'), 'utf8')), res: JSON.parse(readFileSync(p('res'), 'utf8')) }
}

function findSlots(o: Any, out: string[] = [], depth = 0): string[] {
  if (!o || typeof o !== 'object' || depth > 12) return out
  for (const [k, v] of Object.entries(o)) {
    // epoch-ms timestamps (slot start times) or date/time text
    if ((/time|slot|date|epoch|start/i.test(k)) && (typeof v === 'number' && v > 1_700_000_000_000)) out.push(`${k}=${new Date(v).toISOString().slice(0, 16)}`)
    if (typeof v === 'string' && /^\d{1,2}:\d{2}\s*(am|pm)|\b(mon|tue|wed|thu|fri|sat|sun)\b|today|tomorrow/i.test(v) && v.length < 30) out.push(`${k}="${v}"`)
    findSlots(v, out, depth + 1)
  }
  return out
}

async function main() {
  const auth = importFromSession('cdp-user')
  if (!auth) throw new Error('no session — run CDP capture first')
  console.log(`✓ auth ${auth.name} (token ${auth.token.length})`)
  setCoords(12.9719, 77.5937)

  const { body } = captured('getCheckoutJourneySlotPage')
  console.log(`replaying getCheckoutJourneySlotPage (draft ${body.draftOrderId}, city ${body.city}) …`)
  const { status, json } = await apiPost('marketplace/capacityOrionPL/customerFacing/getCheckoutJourneySlotPage', body, auth.token)
  console.log(`HTTP ${status}`)
  if (status === 200) {
    const raw = JSON.stringify(json)
    const noAvail = /Notify when slots are available|no pro|not available/i.test(raw)
    const slots = [...new Set(findSlots(json))].slice(0, 30)
    if (slots.length) {
      console.log(`\n✅ REAL SLOT GRID fetched headless under the account (${slots.length} signals):`)
      for (const s of slots) console.log(`  ${s}`)
    } else if (noAvail) {
      console.log('\n✅ CHAIN WORKS END-TO-END headless under the account — slot page fetched, and UC reports')
      console.log('   NO AVAILABILITY right now for this draft ("Notify when slots are available").')
      console.log('   (A real, correct response — this draft/address currently has no bookable slots.)')
    } else {
      console.log(`\n⚠ 200 but no slot signal / no-availability message. Top keys: ${JSON.stringify(Object.keys((json as Any)?.success?.data ?? json))}`)
    }
  } else {
    console.log(JSON.stringify(json).slice(0, 300))
  }
  await closeClient()
}

main().catch(async (e) => {
  console.error(e)
  await closeClient().catch(() => {})
  process.exit(1)
})
