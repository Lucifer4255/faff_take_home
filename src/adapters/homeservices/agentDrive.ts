import { spawn } from 'node:child_process'
import path from 'node:path'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { MCPClient } from '@mastra/mcp'
import { chromium } from 'playwright'
import { z } from 'zod'

/**
 * Generic home-services checkout driver (replaces the category-locked
 * browserDrive.ts). Instead of hand-coded selectors for one category's
 * "Select requirements" modal, an LLM reads the live accessibility snapshot via
 * Playwright-MCP and drives ANY category to the parked "Proceed to pay" screen.
 * Proven in scratchpad/uc-mcp-drive.ts (home-cleaning, AC, spa all reached pay).
 *
 * Legit posture is identical to auth.ts/the old browserDrive: a REAL Chrome
 * launched as a plain OS process (no Playwright .launch()), the user's OWN
 * captured session (auth.ts, keyed by userId) injected as cookies over CDP, and
 * Playwright-MCP merely *connected* over CDP to that already-logged-in browser —
 * never launching its own. One continuous session, so cart/address/slot state
 * persists; the window is left open as the handoff and we never click pay.
 *
 * Model: gemini-2.5-flash by default (cheap, reliable on the SPA), escalating
 * once to claude-haiku-4.5 if structured verification fails. Both env-tunable.
 */

const CDP_PORT = 9238 // distinct from auth.ts (9235), retired browserDrive (9236), POC (9237)
const CDP_HTTP = `http://localhost:${CDP_PORT}`
const PLAYWRIGHT_MCP_CLI = path.resolve('node_modules/@playwright/mcp/cli.js')
const PRIMARY_MODEL = process.env.UC_DRIVER_MODEL || 'openrouter/google/gemini-2.5-flash'
const FALLBACK_MODEL = process.env.UC_DRIVER_MODEL_FALLBACK || 'openrouter/anthropic/claude-haiku-4.5'
const MAX_STEPS = Number(process.env.UC_DRIVER_MAX_STEPS || 45)

export interface DriveAuth {
  token: string
  ucUserId?: string
  name?: string
}

/** The verified outcome of a drive. The booleans below are filled by the driver
 * agent's final `report_result` call; `screenshotPath` is set by us afterwards. */
export interface DriveResult {
  reachedPay: boolean
  slotSelected: boolean
  payEnabled: boolean
  slotLabel?: string
  amountToPay?: string
  serviceableAtAddress: boolean
  noSlots: boolean
  selectedAddress?: string
  note: string
  screenshotPath?: string
}

/** Zod schema the driver agent must fill via its final `report_result` tool call.
 * Kept constraint-free (no min/max) — it's an LLM-facing tool input schema. */
const DriveReport = z.object({
  reachedPay: z.boolean().describe('true only if the final "Proceed to pay" screen is showing'),
  slotSelected: z.boolean().describe('true only if a specific date+time slot is selected'),
  payEnabled: z.boolean().describe('true only if the "Proceed to pay" button is enabled (not greyed out)'),
  slotLabel: z.string().optional().describe('the selected slot, e.g. "Sat, Jul 11 - 12:00 PM"'),
  amountToPay: z.string().optional().describe('the amount shown to pay, e.g. "₹1,297"'),
  serviceableAtAddress: z.boolean().describe('false if the app said this address/pincode is not serviceable'),
  noSlots: z.boolean().describe('true if no time slots were available for this service/address'),
  selectedAddress: z.string().optional().describe('the exact delivery address you selected at checkout (full text as shown), so the user can verify it is the right one'),
  note: z.string().describe('one short sentence describing where the drive ended'),
})
type DriveReportT = z.infer<typeof DriveReport>

const DRIVER_INSTRUCTIONS = [
  "You operate a REAL, already-logged-in Chrome browser on urbancompany.com through Playwright MCP browser tools. The user is signed in — never try to log in.",
  '',
  'GOAL: add the requested service package to the cart and drive checkout all the way to the final "Proceed to pay" screen — then STOP and report.',
  '',
  'HARD RULE: never click "Proceed to pay", "Pay", "Place order", or anything that charges money or confirms payment. Reaching that screen is success; clicking it is failure.',
  '',
  'The page is a React single-page app. Method for EVERY step:',
  '1. Take a fresh page snapshot before deciding — the DOM changes after each click, and element refs go stale.',
  '2. Act on what the snapshot actually shows, not what you expect.',
  '3. Clicks sometimes silently no-op or the ref is stale. If the expected result did not appear, take another snapshot and retry once before trying another approach.',
  '',
  'Flow (categories differ — read the page, do not assume a fixed shape):',
  '- Find the package card that best matches the request and click its "Add" button.',
  '- A customization / "Select requirements" step MAY appear (or may not). If it does, it has one or more MANDATORY groups (e.g. home size, duration, number of units). For each unanswered mandatory group pick the FIRST / CHEAPEST option. Do NOT add optional upsells. Repeat until "Done"/"Add" is enabled, then click it.',
  '- Click "View Cart".',
  '- Select the delivery address CAREFULLY. There may be MULTIPLE saved addresses — even more than one labelled "Home". If an address hint is given in the request, pick the saved address that best matches it (compare the street / area / locality, NOT just the "Home" label). Only if NO hint is given, fall back to the single default/first address. After selecting, read back the full address text and put it in `selectedAddress` so the user can confirm it is the right one.',
  '- Pick the EARLIEST available time slot.',
  '- Continue ("Proceed" / "Proceed to checkout") until the screen shows "Proceed to pay" with an amount, and that button is ENABLED.',
  '',
  'TERMINAL conditions (stop immediately and report):',
  '- If the app says the address / pincode is NOT serviceable → set serviceableAtAddress=false.',
  '- If the slot grid is empty or says no slots are available → set noSlots=true.',
  '',
  'When you are done (success OR a terminal condition OR genuinely stuck), your LAST action MUST be to call `report_result` exactly once with the verified values. Do not end without calling it.',
].join('\n')

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
  const v = (await (await fetch(`${CDP_HTTP}/json/version`)).json()) as { webSocketDebuggerUrl: string }
  return v.webSocketDebuggerUrl
}
async function ensureDriveChrome(categoryUrl: string): Promise<void> {
  if (await cdpUp()) return
  const profile = `/tmp/uc-drive-${Date.now()}`
  const child = spawn(chromeBinary(), [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--new-window', categoryUrl], { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Chrome did not come up on :${CDP_PORT}`)
}

const isOk = (r: DriveReportT): boolean => r.reachedPay && r.slotSelected && r.payEnabled
const isTerminal = (r: DriveReportT): boolean => r.serviceableAtAddress === false || r.noSlots === true

/** One drive attempt with a given model, against the already-running,
 * session-injected Chrome. Returns the agent's reported result (or a synthesized
 * failure if it never called report_result). */
async function runOnce(model: string, categoryUrl: string, packageName: string, addressHint?: string): Promise<DriveReportT> {
  let captured: DriveReportT | undefined
  const reportTool = createTool({
    id: 'report_result',
    description: 'Report the FINAL verified outcome of the booking drive. Call this exactly once, as your last action.',
    inputSchema: DriveReport,
    execute: async (input: unknown) => {
      captured = input as DriveReportT
      return { acknowledged: true }
    },
  })

  const ws = await wsEndpoint()
  const mcp = new MCPClient({
    id: `uc-drive-${Date.now()}`,
    servers: { browser: { command: 'node', args: [PLAYWRIGHT_MCP_CLI, '--cdp-endpoint', ws] } },
    timeout: 60_000,
  })
  try {
    const tools = { ...(await mcp.listTools()), report_result: reportTool }
    const agent = new Agent({ id: 'uc-checkout-driver', name: 'UC Checkout Driver', model, tools, instructions: DRIVER_INSTRUCTIONS })
    const hint = addressHint ? ` Use the address "${addressHint}".` : ''
    let step = 0
    await agent.generate(`Book "${packageName}" and drive the checkout to an enabled "Proceed to pay" screen, then stop and call report_result. Do not pay.${hint}`, {
      maxSteps: MAX_STEPS,
      // biome-ignore lint/suspicious/noExplicitAny: Mastra step chunk typed loosely
      onStepFinish: (s: any) => {
        step++
        for (const tc of s?.toolCalls ?? []) console.log(`  [uc-drive:${model.split('/').pop()}:${step}] → ${tc?.toolName ?? tc?.name}`)
      },
    })
  } finally {
    await mcp.disconnect().catch(() => {})
  }

  return captured ?? { reachedPay: false, slotSelected: false, payEnabled: false, serviceableAtAddress: true, noSlots: false, note: 'Driver ended without reporting a result.' }
}

/**
 * Drive a logged-in local Chrome through checkout to the parked "Proceed to pay"
 * state for ANY category. Never clicks pay. Escalates model once on failure.
 */
export async function driveToPay(opts: {
  citySlug: string
  cityKey: string
  categoryKey: string
  packageName: string
  addressHint?: string
  auth: DriveAuth
  screenshotDir?: string
}): Promise<DriveResult> {
  const categoryUrl = `https://www.urbancompany.com/${opts.citySlug}-${opts.categoryKey.replace(/_/g, '-')}`

  await ensureDriveChrome(categoryUrl)
  // Inject the per-user session and keep this handle open for the whole run so
  // the cookies are guaranteed present; Playwright-MCP attaches independently.
  const injector = await chromium.connectOverCDP(CDP_HTTP, { timeout: 8000 })
  try {
    const ctx = injector.contexts()[0]
    if (!ctx) throw new Error('no browser context over CDP')
    const cookies = [
      { name: '_uc_user_token', value: opts.auth.token },
      ...(opts.auth.ucUserId ? [{ name: '_uc_user_id', value: opts.auth.ucUserId }] : []),
      ...(opts.auth.name ? [{ name: '_uc_user_name', value: encodeURIComponent(opts.auth.name) }] : []),
    ]
    for (const domain of ['.urbancompany.com', '.urbanclap.com']) {
      await ctx.addCookies(cookies.map((c) => ({ ...c, domain, path: '/', secure: true, sameSite: 'Lax' as const })))
    }

    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    // Advisory login check — positive control scan (a login/sign-up CONTROL,
    // not the mere substring which appears in footers even when signed in).
    // Never abort: if truly logged out the agent hits the wall and reports it,
    // and it can't pay regardless.
    const looksLoggedOut: boolean = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      return controls.some((c) => /^\s*(log ?in|sign ?up|sign ?in)\s*$/i.test(c.textContent || ''))
    })
    if (looksLoggedOut) console.log('⚠ [uc-drive] a login control is visible — session may not have taken; proceeding anyway.')

    // Primary attempt; escalate once on a non-terminal failure, reusing the same
    // already-open Chrome (the SPA cart persists across the retry).
    let report = await runOnce(PRIMARY_MODEL, categoryUrl, opts.packageName, opts.addressHint)
    if (!isOk(report) && !isTerminal(report)) {
      console.log(`↑ [uc-drive] primary (${PRIMARY_MODEL}) did not reach pay — escalating to ${FALLBACK_MODEL}`)
      const fallback = await runOnce(FALLBACK_MODEL, categoryUrl, opts.packageName, opts.addressHint)
      if (isOk(fallback) || (!isOk(report) && isTerminal(fallback))) report = fallback
    }

    let screenshotPath: string | undefined
    if (opts.screenshotDir) {
      screenshotPath = `${opts.screenshotDir}/parked-${Date.now()}.png`
      await page.screenshot({ path: screenshotPath }).catch(() => {
        screenshotPath = undefined
      })
    }

    return { ...report, screenshotPath }
  } finally {
    await injector.close().catch(() => {}) // detaches CDP only; leaves the window open for the user to pay
  }
}
