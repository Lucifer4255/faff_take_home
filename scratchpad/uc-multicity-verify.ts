import { homeservices, closeClient } from '../src/adapters/homeservices'
const ctx = { sessionId:'mc', userId:'mc' }
async function tryLoc(label:string, lat:number, lon:number){
  const loc = await homeservices.configureLocation!(lat,lon)
  const res = await homeservices.tools.search_catalog!({query:'deep cleaning'}, ctx) as any
  const n = Array.isArray(res)? res.length : `ERR ${JSON.stringify(res)}`
  console.log(`${label} (${lat},${lon}) → resolved "${loc.label}" serviceable=${loc.serviceable} → ${n} services`)
}
async function main(){
  await tryLoc('Gurugram', 28.4229, 77.0447)     // was the failing case
  await tryLoc('Koramangala BLR', 12.9352, 77.6245)
  await tryLoc('Mumbai Bandra', 19.0596, 72.8295)
  await tryLoc('Chennai', 13.0827, 80.2707)
  await tryLoc('remote (Leh)', 34.1526, 77.5771)  // far from any metro
  await closeClient()
}
main().catch(async e=>{console.error(e);await closeClient();process.exit(1)})
