import { mkdirSync, writeFileSync } from 'node:fs'
import type { Response } from 'playwright'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'
async function main(){
  mkdirSync('scratchpad/uc',{recursive:true})
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless:true })
  const page = await ctx.newPage()
  const hits:string[]=[]; let n=0
  ctx.on('response', async (r:Response)=>{
    const u=r.url()
    if(!/urbanclap\.com\/api\/v2\//.test(u)) return
    if(/log|monitor|metric|getconfig|newevent|pushLogs|sampleRate|WidgetReloadStatus/i.test(u)) return
    let t=''; try{t=await r.text()}catch{}
    writeFileSync(`scratchpad/uc/cities-${String(n).padStart(2,'0')}.json`,t||'(empty)')
    hits.push(`[${n}] ${r.request().method()} ${r.status()} ${u.replace('https://www.urbanclap.com/api/v2/','…/').split('?')[0]}  ${(r.request().postData()||'').slice(0,90)}`)
    n++
  })
  await page.goto('https://www.urbancompany.com/bangalore',{waitUntil:'domcontentloaded',timeout:60000})
  await page.waitForTimeout(3500)
  console.log('--- clicking location bar (top-left) ---')
  await page.mouse.click(380,40)  // location selector
  await page.waitForTimeout(3000)
  await page.screenshot({path:'scratchpad/uc/cities-picker.png'})
  // type a city to trigger geocode/autocomplete
  const tel = page.locator('input').first()
  if(await tel.count().then(c=>c>0).catch(()=>false)){
    await tel.click({timeout:3000}).catch(()=>{})
    await tel.pressSequentially('Mumbai',{delay:100}).catch(()=>{})
    await page.waitForTimeout(3000)
    await page.screenshot({path:'scratchpad/uc/cities-typed.png'})
  }
  console.log(hits.join('\n'))
  await browser.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
