/**
 * Verify the Urban Company home-services adapter end-to-end against LIVE UC
 * (guest, no auth). search_catalog → select_slot → get_state → confirm.
 *
 * Run: npx tsx scripts/verify-uc.ts
 */
import { closeClient, homeservices } from '../src/adapters/homeservices'

const ctx = { sessionId: 'verify-uc', userId: 'verify-uc' }
const t = homeservices.tools

async function main() {
  console.log('=== search_catalog "deep cleaning" ===')
  const results = (await t.search_catalog?.({ query: 'deep cleaning' }, ctx)) as Array<Record<string, unknown>>
  if (!Array.isArray(results)) {
    console.log('unexpected:', results)
    process.exit(1)
  }
  for (const s of results.slice(0, 8)) console.log(`  ${s.id}  ${s.startsAt ? 'from ' : ''}₹${s.price}  ★${s.rating ?? '-'}  ${s.name} — ${s.category}`)

  // Pick a "Full Home / deep cleaning" result if present, else the first.
  const pick = results.find((s) => /deep clean|full home/i.test(`${s.name} ${s.category}`)) ?? results[0]
  console.log(`\n=== select_slot ${pick.id} (${pick.name}) ===`)
  const selected = await t.select_slot?.({ slotId: String(pick.id) }, ctx)
  console.log(JSON.stringify(selected, null, 2))

  console.log('\n=== get_state ===')
  console.log(JSON.stringify(await t.get_state?.({}, ctx), null, 2))

  console.log('\n=== confirm (booking-ready handoff) ===')
  console.log(JSON.stringify(await t.confirm?.({ summary: `Book ${pick.name}` }, ctx), null, 2))

  await closeClient()
}

main().catch(async (e) => {
  console.error(e)
  await closeClient().catch(() => {})
  process.exit(1)
})
