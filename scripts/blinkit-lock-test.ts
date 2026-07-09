import './preload'
import { chromium } from 'playwright'
import { closeClient, getLocation } from '../src/adapters/blinkit/client'

// Hold the canonical profile open with a first browser, then make the client
// launch — it must NOT hard-fail; it should fall back to a private profile.
async function main() {
  console.log('[hold] opening .playwright/blinkit in a first context…')
  const holder = await chromium.launchPersistentContext('.playwright/blinkit', { headless: false })
  try {
    console.log('[client] getLocation() should fall back to a private profile…')
    const loc = await getLocation()
    console.log('[client] OK — resolved location:', JSON.stringify(loc))
  } finally {
    await closeClient()
    await holder.close()
  }
}
main()
  .catch((e) => {
    console.error('LOCK TEST FAILED:', e)
    process.exitCode = 1
  })
  .finally(() => process.exit(process.exitCode ?? 0))
