import { readFileSync } from 'node:fs'
import { loadDotEnv } from '@/core/env'
import { driveToPay } from '@/adapters/homeservices/agentDrive'

loadDotEnv()

async function main() {
  const store = JSON.parse(readFileSync('.data/uc-auth.json', 'utf8')) as Record<string, { token: string; ucUserId?: string; name?: string; savedAt: number }>
  const [id, auth] = Object.entries(store).filter(([, a]) => a?.token).sort(([, a], [, b]) => (b.savedAt ?? 0) - (a.savedAt ?? 0))[0]
  console.log(`session: ${auth.name} [${id}]`)

  const r = await driveToPay({
    citySlug: 'bangalore',
    cityKey: 'city_bangalore_v2',
    categoryKey: 'professional_home_cleaning',
    packageName: 'full home deep cleaning',
    auth: { token: auth.token, ucUserId: auth.ucUserId, name: auth.name },
    screenshotDir: '.data/uc-drive-screenshots',
  })
  console.log('\n===== DriveResult =====')
  console.log(JSON.stringify(r, null, 2))
  process.exit(0)
}
main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
