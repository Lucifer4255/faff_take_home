import readline from 'node:readline'
import { AgentEvent } from '@/core/events'

/**
 * CLI chat client — a first-class client of the same /api SSE stream the web UI
 * uses (DESIGN.md §4). Usage: npm run cli -- "get me 2L milk to Koramangala"
 */
const base = process.env.API_URL ?? 'http://127.0.0.1:3123'
const text = process.argv.slice(2).join(' ').trim()
if (!text) {
  console.error('usage: npm run cli -- "<request>"')
  process.exit(1)
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
let sessionId = ''

// Line queue so a reply works whether typed interactively or piped in (a piped
// line that arrives before the prompt is buffered, and stdin EOF never crashes).
const queued: string[] = []
const waiters: ((line: string) => void)[] = []
rl.on('line', (line) => {
  const w = waiters.shift()
  if (w) w(line)
  else queued.push(line)
})
function nextLine(): Promise<string> {
  const q = queued.shift()
  if (q !== undefined) return Promise.resolve(q)
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
    case 'state_update':
      console.log(`\n📦 ${JSON.stringify(event.state)}`)
      break
    case 'awaiting_confirmation':
      console.log(
        `\n⚠️  EXECUTE gate: ${event.summary}` +
          (event.amount != null ? ` — ₹${event.amount} ${event.currency ?? 'INR'}` : ''),
      )
      console.log('   type "confirm" to approve, anything else to cancel')
      prompt()
      break
    case 'done':
      console.log(`\n✅ done${event.summary ? `: ${event.summary}` : ''}`)
      process.exit(0)
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

async function main() {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
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
