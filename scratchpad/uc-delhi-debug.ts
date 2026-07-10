import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'
const H:Record<string,string>={'content-type':'application/json',accept:'application/json, text/plain, */*','x-brand-key':'urbanCompany','x-device-id':`v-${Date.now()}`,'x-device-os':'desktop_web','x-version-code':'4.273.58','x-version-name':'web_v4.273.58','react-bundle-version':'798','x-preferred-language':'english','accept-language':'en-IN'}
async function main(){
  const {browser,ctx}=await launchIdentity(IDENTITIES[0],{headless:true})
  const page=await ctx.newPage()
  await page.goto('https://www.urbancompany.com/delhi',{waitUntil:'domcontentloaded',timeout:60000})
  await page.waitForTimeout(2500)
  for(const q of ['deep cleaning','cleaning']){
    const r=await page.evaluate(async({H,q})=>{
      const res=await fetch('https://www.urbanclap.com/api/v2/growth/search/discoverySearch',{method:'POST',credentials:'omit',headers:H,body:JSON.stringify({city_key:null,location:{longitude:77.0447,latitude:28.4229},cityKey:'city_delhi_v2',searchToken:q,source:'homescreen',sourceMetadata:{pageName:'homescreen'},recentSearches:[]})})
      const t=await res.text();const j=JSON.parse(t)
      const items=j?.success?.data?.dataStore?.searchResultsCard?.items||[]
      const types=items.map((it:any)=>it?.data?.tapAction?.data?.metaData?.searchResultType||it?.data?.tapAction?.type||'?')
      return {status:res.status,count:items.length,types}
    },{H,q})
    console.log(`"${q}": HTTP ${r.status}, items=${r.count}, types=${JSON.stringify(r.types)}`)
  }
  await browser.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
