import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'
const H:Record<string,string> = {
  'content-type':'application/json', accept:'application/json, text/plain, */*',
  'x-brand-key':'urbanCompany','x-device-id':`v-${Date.now()}`,'x-device-os':'desktop_web',
  'x-version-code':'4.273.58','x-version-name':'web_v4.273.58','react-bundle-version':'798',
  'x-preferred-language':'english','accept-language':'en-IN',
}
const C = [
  ['mumbai',19.0760,72.8777],['delhi',28.6139,77.2090],['pune',18.5204,73.8567],
  ['hyderabad',17.3850,78.4867],['chennai',13.0827,80.2707],['kolkata',22.5726,88.3639],
  ['gurgaon',28.4595,77.0266],['gurugram',28.4595,77.0266],['noida',28.5355,77.3910],
  ['ahmedabad',23.0225,72.5714],['jaipur',26.9124,75.7873],['chandigarh',30.7333,76.7794],
] as const
async function main(){
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless:true })
  const page = await ctx.newPage()
  await page.goto('https://www.urbancompany.com/mumbai',{waitUntil:'domcontentloaded',timeout:60000})
  await page.waitForTimeout(2500)
  for(const [slug,lat,lon] of C){
    const body={ city_key:null, location:{longitude:lon,latitude:lat}, cityKey:`city_${slug}_v2`, searchToken:'cleaning', source:'homescreen', sourceMetadata:{pageName:'homescreen'}, recentSearches:[] }
    const r = await page.evaluate(async ({H,body})=>{
      const res=await fetch('https://www.urbanclap.com/api/v2/growth/search/discoverySearch',{method:'POST',credentials:'omit',headers:H,body:JSON.stringify(body)})
      const t=await res.text(); let n=0; try{const j=JSON.parse(t); n=(j?.success?.data?.dataStore?.searchResultsCard?.items||[]).length}catch{}
      return { s:res.status, n }
    },{H,body})
    console.log(`city_${slug}_v2 → HTTP ${r.s}, ${r.n} services`)
  }
  await browser.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
