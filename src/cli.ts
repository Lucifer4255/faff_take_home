import readline from 'node:readline'
import { AgentEvent } from '@/core/events'

/**
 * CLI chat client — a first-class client of the same /api SSE stream the web UI
 * uses (DESIGN.md §4).
 *   npm run cli -- "get me 2L milk to Koramangala"
 *   npm run cli -- --location 12.9352,77.6245 "get me 2L milk"   # explicit coords
 *   npm run cli -- --ip-location "get me 2L milk"                # auto: geo-IP
 * With no location flag the server reuses the last-captured location (e.g. from
 * the web UI) or falls back to the default store — a CLI has no browser GPS.
 */
const base = process.env.API_URL ?? 'http://127.0.0.1:3123'

// Parse flags out of argv, leave the free text.
const argv = process.argv.slice(2)
let locationArg: string | undefined
let ipLocation = false
const words: string[] = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--location') locationArg = argv[++i]
  else if (argv[i] === '--ip-location') ipLocation = true
  else words.push(argv[i])
}
const text = words.join(' ').trim()
if (!text) {
  console.error('usage: npm run cli -- [--location lat,lon | --ip-location] "<request>"')
  process.exit(1)
}

/** Resolve the CLI's delivery location: explicit --location, or --ip-location via
 * a geo-IP lookup. Returns undefined so the server uses its persisted/default. */
async function resolveLocation(): Promise<{ lat: number; lon: number } | undefined> {
  if (locationArg) {
    const [lat, lon] = locationArg.split(',').map((n) => Number(n.trim()))
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon }
    console.error(`⚠ bad --location "${locationArg}" (want lat,lon); ignoring`)
  }
  if (ipLocation) {
    try {
      const r = await fetch('https://ipapi.co/json/').then((x) => x.json() as Promise<{ latitude?: number; longitude?: number; city?: string }>)
      if (typeof r.latitude === 'number' && typeof r.longitude === 'number') {
        console.log(`📍 geo-IP → ${r.city ?? ''} (${r.latitude}, ${r.longitude})`)
        return { lat: r.latitude, lon: r.longitude }
      }
    } catch {
      console.error('⚠ geo-IP lookup failed; using the default store')
    }
  }
  return undefined
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
let sessionId = ''

// Line queue so a reply works whether typed interactively or piped in (a piped
// line that arrives before the prompt is buffered, and stdin EOF never crashes).
const queued: string[] = []
const waiters: ((line: string) => void)[] = []
let stdinClosed = false
rl.on('line', (line) => {
  const w = waiters.shift()
  if (w) w(line)
  else queued.push(line)
})
// Piped input ends (EOF): don't exit outright (a turn may still be streaming) —
// just release any pending prompt with '' so promptContinue/prompt can wrap up.
rl.on('close', () => {
  stdinClosed = true
  const w = waiters.shift()
  if (w) w('')
})
function nextLine(): Promise<string> {
  const q = queued.shift()
  if (q !== undefined) return Promise.resolve(q)
  if (stdinClosed) return Promise.resolve('')
  return new Promise((resolve) => waiters.push(resolve))
}

function render(event: AgentEvent): void {
  switch (event.type) {
    case 'agent_message':
      console.log(`\n🤖 ${event.text}`)
      break
    case 'question':
      console.log(`\n❓ ${event.text}${event.options ? `  [${event.options.join(' / ')}]` : ''}`)
      prompt()
      break
    case 'action':
      console.log(`   … ${event.label}`)
      break
    case 'state_update': {
      console.log(`\n📦 ${JSON.stringify(event.state)}`)
      const st = event.state as { checkoutUrl?: string; service?: string; order?: { checkoutUrl?: string } }
      const url = st?.checkoutUrl ?? st?.order?.checkoutUrl
      if (url) console.log(`${st?.service ? '🧹 booking link' : '🛒 cart link'}: ${url}`)
      break
    }
    case 'awaiting_confirmation':
      console.log(
        `\n⚠️  EXECUTE gate: ${event.summary}` +
          (event.amount != null ? ` — ₹${event.amount} ${event.currency ?? 'INR'}` : ''),
      )
      console.log('   type "confirm" to approve, anything else to cancel')
      prompt()
      break
    case 'done':
      // A turn finished — the conversation stays open for follow-ups.
      void promptContinue()
      break
    case 'error':
      console.error(`\n❌ ${event.message}`)
      process.exit(1)
  }
}

async function prompt(): Promise<void> {
  process.stdout.write('> ')
  const answer = await nextLine()
  await fetch(`${base}/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: answer }),
  })
}

/** After a turn completes, keep the conversation open: prompt for a follow-up,
 * or exit on an empty line / "quit". */
async function promptContinue(): Promise<void> {
  process.stdout.write('\n(follow up, or "quit") > ')
  const answer = (await nextLine()).trim()
  if (!answer || /^(quit|exit|q)$/i.test(answer)) return process.exit(0)
  await fetch(`${base}/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: answer }),
  })
}

async function main() {
  const location = await resolveLocation()
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Stable user id so a CLI login persists across runs (override via FAFF_USER_ID).
    body: JSON.stringify({ text, ...(location ? { location } : {}), userId: process.env.FAFF_USER_ID || 'cli-user' }),
  }).catch(() => {
    console.error(`❌ cannot reach ${base} — start the app with: npm run dev`)
    process.exit(1)
  })
  const body = await res.text()
  if (!res.ok || !body) {
    console.error(`❌ ${base} answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ' (empty)'}`)
    process.exit(1)
  }
  sessionId = (JSON.parse(body) as { sessionId: string }).sessionId
  console.log(`session ${sessionId}`)

  const stream = await fetch(`${base}/api/sessions/${sessionId}/stream`)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6)
      if (data) render(AgentEvent.parse(JSON.parse(data)))
    }
  }
}
void main()
