/**
 * Prove the fix: identities rotate but the delivery LOCATION stays pinned, and
 * search keeps working after every rotation. This reproduces the "not
 * serviceable after a rotation" scenario deterministically via rotateNow().
 *
 *   npx tsx scripts/blinkit-rotation-test.ts
 *   BLINKIT_LAT=12.9352 BLINKIT_LON=77.6245 npx tsx scripts/blinkit-rotation-test.ts  # custom location
 */
import './preload'
import { closeClient, currentIdentity, getLocation, rotateNow, searchRaw } from '../src/adapters/blinkit/client'
import { extractProducts } from '../src/adapters/blinkit/parse'

async function main() {
  const start = await getLocation()
  console.log(`start: id=${await currentIdentity()} loc=(${start.lat},${start.lon}) serviceable=${start.serviceable} "${start.address}"`)
  const baseline = `${start.lat},${start.lon}`
  let failures = 0

  for (let i = 1; i <= 4; i++) {
    const id = await rotateNow()
    const loc = await getLocation()
    const eggs = extractProducts(await searchRaw('eggs')).length
    const curd = extractProducts(await searchRaw('curd')).length
    const sameLoc = `${loc.lat},${loc.lon}` === baseline
    const ok = sameLoc && loc.serviceable && eggs > 0 && curd > 0
    console.log(`rotate ${i}: id=${id} loc=(${loc.lat},${loc.lon}) same=${sameLoc} serviceable=${loc.serviceable} eggs=${eggs} curd=${curd} ${ok ? '✅' : '❌'}`)
    if (!ok) failures++
  }
  console.log(failures === 0 ? '\n✅ PASS: location pinned + search works across all rotations' : `\n❌ FAIL: ${failures} rotation(s) broke`)
  process.exitCode = failures === 0 ? 0 : 1
}
main()
  .catch((e) => {
    console.error('ROTATION TEST FAIL', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeClient()
    process.exit(process.exitCode ?? 0)
  })
