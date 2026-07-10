import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'
const H = {
  'content-type':'application/json', accept:'application/json, text/plain, */*',
  'x-brand-key':'urbanCompany','x-device-id':`v-${Date.now()}`,'x-device-os':'desktop_web',
  'x-version-code':'4.273.58','x-version-name':'web_v4.273.58','react-bundle-version':'798',
  'x-preferred-language':'english','accept-language':'en-IN',
}
async function main(){
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless:true })
  const page = await ctx.newPage()
  await page.goto('https://www.urbancompany.com/kolkata',{waitUntil:'domcontentloaded',timeout:60000})
  await page.waitForTimeout(2500)
  // Gurugram/Delhi coords, cityKey NULL — does the server resolve the city from coords?
  const cases = [
    { name:'Delhi coords, cityKey null', body:{ city_key:null, location:{longitude:77.0447,latitude:28.4229}, cityKey:null, searchToken:'deep cleaning', source:'homescreen', sourceMetadata:{pageName:'homescreen'}, recentSearches:[] } },
    { name:'Kolkata coords, cityKey null', body:{ city_key:null, location:{longitude:88.3639,latitude:22.5726}, cityKey:null, searchToken:'deep cleaning', source:'homescreen', sourceMetadata:{pageName:'homescreen'}, recentSearches:[] } },
    { name:'Delhi coords, cityKey city_delhi_v2', body:{ city_key:null, location:{longitude:77.0447,latitude:28.4229}, cityKey:'city_delhi_v2', searchToken:'deep cleaning', source:'homescreen', sourceMetadata:{pageName:'homescreen'}, recentSearches:[] } },
  ]
  for (const c of cases){
    const r = await page.evaluate(async ({H,body})=>{
      const res = await fetch('https://www.urbanclap.com/api/v2/growth/search/discoverySearch',{method:'POST',credentials:'omit',headers:H as Record<string,string>,body:JSON.stringify(body)})
      const t = await res.text()
      let n=0; try{ const j=JSON.parse(t); const items=j?.success?.data?.dataStore?.searchResultsCard?.items||[]; n=items.length }catch{}
      return { status:res.status, len:t.length, n, head:t.slice(0,140) }
    },{H,body:c.body})
    console.log(`\n${c.name}: HTTP ${r.status}, resultsCard items=${r.n}, bytes=${r.len}`)
    if(r.status!==200||r.n===0) console.log('  head:',r.head)
  }
  await browser.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
