import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Agent } from '@mastra/core/agent'
import { MCPClient } from '@mastra/mcp'
import { chromium } from 'playwright'
import { loadDotEnv } from '@/core/env'

/**
 * POC: drive Urban Company home-cleaning checkout to the "Proceed to pay" screen
 * with an LLM-DRIVEN browser agent — Mastra Agent + Playwright-MCP over the SAME
 * real, session-injected local Chrome that browserDrive.ts uses today.
 *
 * The point of the experiment: browserDrive.ts drives the same flow with
 * hand-coded selectors and is explicitly scoped to home-cleaning because each
 * category's "Select requirements" modal is a different shape. Here the agent
 * reads the live accessibility snapshot and fills whatever modal it finds, which
 * is the piece that should generalise past a single category.
 *
 * Legit posture is preserved exactly as in browserDrive.ts: a REAL Chrome
 * launched as a plain OS process (no Playwright .launch()), the user's own
 * captured session injected as cookies, and Playwright-MCP merely *connected*
 * over CDP to that already-logged-in browser — never launching its own.
 *
 * Isolated on purpose: nothing here touches the production adapter. Run:
 *   npx tsx scratchpad/uc-mcp-drive.ts "Home deep cleaning"
 *   npx tsx scratchpad/uc-mcp-drive.ts --user <userId> --city bangalore "Bathroom cleaning"
 * It stops at "Proceed to pay" and leaves the window open — it never pays.
 */

loadDotEnv()

const MODEL = process.env.MODEL || 'openrouter/anthropic/claude-sonnet-4.5'
const PLAYWRIGHT_MCP_CLI = path.resolve('node_modules/@playwright/mcp/cli.js')

// ---- args ----
const argv = process.argv.slice(2)
let userId: string | undefined
let citySlug = process.env.UC_CITY || 'bangalore'
let categoryKey = 'professional_home_cleaning'
let cdpPort = 9237 // distinct from auth.ts (9235) and browserDrive.ts (9236)
const words: string[] = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--user') userId = argv[++i]
  else if (argv[i] === '--city') citySlug = argv[++i]
  else if (argv[i] === '--category') categoryKey = argv[++i]
  else if (argv[i] === '--port') cdpPort = Number(argv[++i])
  else words.push(argv[i])
}
const CDP_PORT = cdpPort
const CDP_HTTP = `http://localhost:${CDP_PORT}`
const packageName = words.join(' ').trim() || 'the full home deep cleaning package'
const categoryUrl = `https://www.urbancompany.com/${citySlug}-${categoryKey.replace(/_/g, '-')}`

// ---- captured session ----
interface UCAuth {
  token: string
  ucUserId?: string
  name?: string
  savedAt: number
}
function loadAuth(): { id: string; auth: UCAuth } {
  const file = '.data/uc-auth.json'
  if (!existsSync(file)) throw new Error(`${file} not found — no captured UC session. Log in through the adapter first.`)
  const store = JSON.parse(readFileSync(file, 'utf8')) as Record<string, UCAuth>
  const entries = Object.entries(store).filter(([, a]) => a?.token)
  if (entries.length === 0) throw new Error('no captured UC session with a token in .data/uc-auth.json')
  if (userId) {
    const hit = store[userId]
    if (!hit?.token) throw new Error(`no session for --user ${userId}`)
    return { id: userId, auth: hit }
  }
  // default: the most recently captured session
  entries.sort(([, a], [, b]) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
  return { id: entries[0][0], auth: entries[0][1] }
}

function chromeBinary(): string {
  return process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome'
}
async function cdpUp(): Promise<boolean> {
  try {
    return (await fetch(`${CDP_HTTP}/json/version`)).ok
  } catch {
    return false
  }
}
async function wsEndpoint(): Promise<string> {
  const v = await (await fetch(`${CDP_HTTP}/json/version`)).json()
  return v.webSocketDebuggerUrl as string
}
async function ensureChrome(): Promise<void> {
  if (await cdpUp()) return
  const profile = `/tmp/uc-mcp-${Date.now()}`
  const child = spawn(chromeBinary(), [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--new-window', categoryUrl], { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Chrome did not come up on :${CDP_PORT}`)
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set (checked .env)')
  const { id, auth } = loadAuth()
  console.log(`▸ session: ${auth.name ?? '(unnamed)'}  [${id}]  saved ${new Date(auth.savedAt).toISOString()}`)
  console.log(`▸ target : ${categoryUrl}`)
  console.log(`▸ package: ${packageName}\n`)

  await ensureChrome()

  // Inject the captured session into the running Chrome (same recipe as
  // browserDrive.ts). Keep this Playwright handle open for the whole run so the
  // cookies are guaranteed present; Playwright-MCP attaches as a second CDP
  // client independently.
  const injector = await chromium.connectOverCDP(CDP_HTTP, { timeout: 8000 })
  const ctx = injector.contexts()[0]
  if (!ctx) throw new Error('no browser context over CDP')
  const cookies = [
    { name: '_uc_user_token', value: auth.token },
    ...(auth.ucUserId ? [{ name: '_uc_user_id', value: auth.ucUserId }] : []),
    ...(auth.name ? [{ name: '_uc_user_name', value: encodeURIComponent(auth.name) }] : []),
  ]
  for (const domain of ['.urbancompany.com', '.urbanclap.com']) {
    await ctx.addCookies(cookies.map((c) => ({ ...c, domain, path: '/', secure: true, sameSite: 'Lax' as const })))
  }
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto(categoryUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  // Positive login signal, not a substring scan: a genuine logged-out page shows
  // a login/sign-up CONTROL (button/link whose whole label is "Log in" etc.).
  // The mere words "Login"/"Sign up" appear in footers/menus even when signed in
  // (e.g. the spa-at-home page), so scanning innerText false-positives. Even so,
  // this is only advisory — never abort; if truly logged out the agent will hit
  // the wall and report it, and it can't pay regardless.
  const looksLoggedOut: boolean = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'))
    return controls.some((c) => /^\s*(log ?in|sign ?up|sign ?in)\s*$/i.test(c.textContent || ''))
  })
  if (looksLoggedOut) console.log('⚠ a login control is visible — the session may not have taken; proceeding anyway (the agent will report if it hits a login wall).')
  console.log('✓ session injected — handing the browser to the agent via Playwright-MCP\n')

  // Playwright-MCP connected to the SAME Chrome over CDP (never launches its own).
  const ws = await wsEndpoint()
  const mcp = new MCPClient({
    id: 'uc-browser-poc',
    servers: {
      browser: {
        command: 'node',
        args: [PLAYWRIGHT_MCP_CLI, '--cdp-endpoint', ws],
      },
    },
    timeout: 60_000,
  })

  const tools = await mcp.listTools()
  console.log(`▸ Playwright-MCP tools: ${Object.keys(tools).join(', ')}\n`)

  const agent = new Agent({
    id: 'uc-browser-booker',
    name: 'UC Browser Booker',
    model: MODEL,
    tools,
    instructions: [
      'You operate a REAL, already-logged-in Chrome browser on urbancompany.com through Playwright MCP browser tools. The user is signed in; do not try to log in.',
      '',
      'GOAL: add the requested home-cleaning package to the cart and drive checkout all the way to the final "Proceed to pay" screen — then STOP.',
      '',
      'HARD RULE: never click "Proceed to pay", "Pay", "Place order", or anything that charges money or confirms payment. Reaching that screen is success; clicking it is failure.',
      '',
      'The page is a React single-page app. Method for every step:',
      '1. Take a fresh page snapshot before deciding — the DOM changes after each click.',
      '2. Act on what the snapshot actually shows, not what you expect.',
      '3. Clicks sometimes silently no-op. If the expected element did not appear after a click, take another snapshot and retry the click once before trying another approach.',
      '',
      'Flow:',
      '- Find the package card that best matches the request and click its "Add" button.',
      '- A "Select requirements"/customization modal usually appears with one or more MANDATORY single-select groups (e.g. home size, kitchen, sofa/mattress). For each unanswered group pick the first / cheapest option. Repeat until the "Done" button is enabled, then click "Done".',
      '- Click "View Cart".',
      '- If asked to select an address, choose the saved "Home" address (or the first saved address), then click "Proceed".',
      '- If asked for a time slot, pick the earliest available time, then click "Proceed to checkout".',
      '- You are done when the screen shows "Proceed to pay" together with an amount. Report the selected slot and the amount to pay. STOP there.',
      '',
      'Keep going through these steps autonomously; only stop when you reach the pay screen or are truly stuck.',
    ].join('\n'),
  })

  let step = 0
  const res = await agent.generate(`Book "${packageName}" and drive the checkout to the "Proceed to pay" screen, then stop. Do not pay.`, {
    maxSteps: 45,
    onStepFinish: (s: unknown) => {
      const st = s as { toolCalls?: Array<{ toolName?: string; args?: unknown }>; text?: string }
      step++
      for (const tc of st.toolCalls ?? []) {
        const a = JSON.stringify(tc.args ?? {})
        console.log(`  [${step}] → ${tc.toolName}(${a.length > 120 ? `${a.slice(0, 120)}…` : a})`)
      }
      if (st.text?.trim()) console.log(`  [${step}] · ${st.text.trim().slice(0, 200)}`)
    },
  })

  console.log(`\n===== agent final =====\n${res.text}\n`)
  await mcp.disconnect().catch(() => {})
  await injector.close().catch(() => {}) // detaches CDP only; leaves the Chrome window open for the user to pay
  console.log('▸ Chrome left open. Nothing was paid.')
  process.exit(0)
}

main().catch((e) => {
  console.error('\n✗ POC failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
