/**
 * Prove Tier B: our HEADLESS client can act as the logged-in user by injecting
 * the captured Bearer token. Calls getDiscoveryScreen with and without the token
 * from a fresh headless identity (own Cloudflare pass) — authed should return the
 * real userId, guest should not.
 *
 * Run: npx tsx scripts/uc-auth-verify.ts
 */
import { readFileSync } from 'node:fs'
import { IDENTITIES, launchIdentity } from '../src/adapters/blinkit/identities'

function token(): string {
  const ss = JSON.parse(readFileSync('.data/uc-session.json', 'utf8'))
  // The Authorization header uses the 44-char _uc_user_token (the _access_token
  // cookie is its URL-encoded twin).
  const c = ss.cookies?.find((c: { name: string }) => c.name === '_uc_user_token')
  if (!c) throw new Error('no _uc_user_token in .data/uc-session.json — capture the session first')
  return c.value
}

async function main() {
  const tk = token()
  const { browser, ctx } = await launchIdentity(IDENTITIES[0], { headless: true })
  const page = await ctx.newPage()
  await page.goto('https://www.urbancompany.com/bangalore', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(2500)

  const call = async (withAuth: boolean) => {
    return page.evaluate(
      async ({ withAuth, tk }) => {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'application/json, text/plain, */*',
          'x-brand-key': 'urbanCompany',
          'x-device-id': 'v-1783608160',
          'x-device-os': 'desktop_web',
          'x-version-code': '4.273.58',
          'x-version-name': 'web_v4.273.58',
          'react-bundle-version': '798',
          'x-preferred-language': 'english',
          'accept-language': 'en-IN',
        }
        if (withAuth) headers.authorization = `Bearer ${tk}`
        const res = await fetch('https://www.urbanclap.com/api/v2/growth/customerHomescreen/getDiscoveryScreen', {
          method: 'POST',
          credentials: 'omit',
          headers,
          body: JSON.stringify({
            city_key: null,
            cityKey: 'city_bangalore_v2',
            customerId: '',
            seoURL: 'https://www.urbancompany.com/bangalore',
            countryKey: 'IND',
            locationDetails: { lat: 12.961947, long: 77.603264 },
            placeId: 'ChIJrT4dCtQVrjsRPRIJt171Zw8',
            homescreenAddress: { ucAddress: {}, placeId: 'ChIJrT4dCtQVrjsRPRIJt171Zw8', formattedAddress: '3, Norris Rd, Richmond Town, Bengaluru, Karnataka 560025, India' },
            discoveryPage: 'homescreen',
            visibleBottomTabs: [],
          }),
        })
        const t = await res.text()
        const m = t.match(/"userId"\s*:\s*"([a-f0-9]{16,})"/)
        return { status: res.status, userId: m?.[1] ?? null }
      },
      { withAuth, tk },
    )
  }

  const guest = await call(false)
  const authed = await call(true)
  console.log(`guest  → HTTP ${guest.status}, userId=${guest.userId ?? '(none)'}`)
  console.log(`authed → HTTP ${authed.status}, userId=${authed.userId ?? '(none)'}`)
  console.log(authed.userId && !guest.userId ? '\n✅ TIER B PROVEN: headless client authenticates as the logged-in user via the injected Bearer token.' : '\n⚠ token did not distinguish — inspect further')
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
