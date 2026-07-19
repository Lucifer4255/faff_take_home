import { closeClient, deepLink, quote, resolve } from '../src/adapters/delivery/client'

async function main() {
  const u = 'smoketest'
  const p = await resolve(u, 'Park Street', 'PICKUP')
  const d = await resolve(u, 'Quest Mall', 'DROPOFF')
  console.log('pickup:', p?.title, '@', p?.latitude, p?.longitude)
  console.log('drop:  ', d?.title, '@', d?.latitude, d?.longitude)
  if (p && d) {
    console.log('deepLink starts:', deepLink(p, d).slice(0, 70), '…')
    const q = await quote(u, p, d)
    console.log('quote loggedIn:', q.loggedIn, '| options:', q.products.length, q.products.map((o) => `${o.displayName} ${o.fare}`).join(', '))
  }
  await closeClient()
  console.log('OK')
}
main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
