import { chromium } from 'playwright'
async function main(){
  const b = await chromium.connectOverCDP('http://localhost:9222',{timeout:8000})
  const ctx = b.contexts()[0]
  const want = /getPersistentCartIconData|getDiscoveryScreen/
  const seen = new Set<string>()
  ctx.on('request', (req)=>{
    const u=req.url()
    if(!want.test(u)) return
    const name = u.split('/').pop()!.split('?')[0]
    if(seen.has(name)) return; seen.add(name)
    console.log(`\n=== ${name} ===`)
    console.log('AUTH header:', req.headers().authorization ? 'Bearer …present' : 'none')
    console.log('BODY:', req.postData())
  })
  const page = ctx.pages().find(p=>/urban/.test(p.url())) ?? await ctx.newPage()
  await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{})
  await page.waitForTimeout(6000)
  await b.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
