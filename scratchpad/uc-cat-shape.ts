import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'
import { writeFileSync } from 'node:fs'
const H:Record<string,string>={'content-type':'application/json',accept:'application/json, text/plain, */*','x-brand-key':'urbanCompany','x-device-id':`v-${Date.now()}`,'x-device-os':'desktop_web','x-version-code':'4.273.58','x-version-name':'web_v4.273.58','react-bundle-version':'798','x-preferred-language':'english','accept-language':'en-IN'}
async function main(){
  const {browser,ctx}=await launchIdentity(IDENTITIES[0],{headless:true})
  const page=await ctx.newPage()
  await page.goto('https://www.urbancompany.com/delhi',{waitUntil:'domcontentloaded',timeout:60000})
  await page.waitForTimeout(2500)
  const t=await page.evaluate(async({H})=>{
    const res=await fetch('https://www.urbanclap.com/api/v2/growth/search/discoverySearch',{method:'POST',credentials:'omit',headers:H,body:JSON.stringify({city_key:null,location:{longitude:77.209,latitude:28.6139},cityKey:'city_delhi_v2',searchToken:'deep cleaning',source:'homescreen',sourceMetadata:{pageName:'homescreen'},recentSearches:[]})})
    return await res.text()
  },{H})
  writeFileSync('scratchpad/uc/delhi-search.json',t)
  await browser.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
