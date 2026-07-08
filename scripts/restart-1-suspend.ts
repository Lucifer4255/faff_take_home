/**
 * Restart durability, part 1 of 2. Stream to the EXECUTE gate and exit WITHOUT
 * approving — simulating a crash while parked at the gate. The run snapshot is
 * left in libSQL (.data/mastra.db); part 2 resumes it in a fresh process.
 * Run: npx tsx scripts/restart-1-suspend.ts
 */
import './preload'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { RequestContext } from '@mastra/core/di'
import { interpret } from '../src/mastra/agents'
import { controllerAgent } from '../src/mastra/index'

async function main() {
  const sessionId = randomUUID()
  const intent = await interpret('get me 2L milk and a loaf of bread to Koramangala 5th block')
  const agent = controllerAgent(intent.service)
  const stream = await agent.stream(`Typed intent:\n${JSON.stringify(intent)}`, {
    requestContext: new RequestContext([['sessionId', sessionId]]),
    maxSteps: 25,
  })

  let runId: string | undefined
  // Drain the stream fully — it ENDS at the approval pause, and that is when
  // Mastra persists the suspend snapshot. (Breaking out early + exiting races
  // the snapshot write, leaving the run "not suspended".)
  // biome-ignore lint: structural
  for await (const chunk of stream.fullStream as any) {
    if (chunk.type === 'tool-call-approval') {
      runId = chunk.runId ?? chunk.payload?.runId ?? stream.runId
      console.log(`\n⚠ reached gate: ${chunk.payload?.args?.summary}`)
    }
  }
  if (!runId) throw new Error('never reached the gate')

  writeFileSync('.data/restart-handoff.json', JSON.stringify({ sessionId, service: intent.service, runId }))
  console.log(`\n[part1] suspended. runId=${runId} sessionId=${sessionId.slice(0, 8)}`)
  console.log('[part1] exiting WITHOUT approving (simulating crash) …')
  process.exit(0)
}
void main()
