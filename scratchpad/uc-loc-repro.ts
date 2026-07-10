import { extractServices } from '../src/adapters/homeservices/parse'
// import client internals via the adapter's client
import { searchServices, setCoords, closeClient, currentCity } from '../src/adapters/homeservices/client'

async function run(label: string) {
  const svc = extractServices(await searchServices('deep cleaning'))
  console.log(`${label}: city=${currentCity().cityKey} → ${svc.length} services`)
}
async function main() {
  await run('DEFAULT Bangalore coords')
  setCoords(28.4229, 77.0447) // Gurugram — far from Bangalore, cityKey still bangalore
  await run('AFTER setCoords(Gurugram)')
  await closeClient()
}
main().catch(async e => { console.error(e); await closeClient(); process.exit(1) })
