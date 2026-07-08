/**
 * Restart durability, part 2 of 2. A FRESH process resumes the gate suspended
 * by part 1 — reading the run snapshot from libSQL — and approves it. If the
 * order is placed with the right cart, the gate survived the "restart".
 * Run: npx tsx scripts/restart-2-resume.ts
 */
import './preload'
import { readFileSync } from 'node:fs'
import { controllerAgent } from '../src/mastra/index'

async function main() {
  const { sessionId, service, runId } = JSON.parse(readFileSync('.data/restart-handoff.json', 'utf8'))
  console.log(`[part2] fresh process — resuming runId=${runId} (service=${service}, sessionId=${sessionId.slice(0, 8)})`)

  const agent = controllerAgent(service)
  const approved = await agent.approveToolCall({ runId })

  let order: unknown
  // biome-ignore lint: structural
  for await (const chunk of approved.fullStream as any) {
    if (chunk.type === 'tool-result') order = chunk.payload?.result ?? chunk.payload
    if (chunk.type === 'text-delta') process.stdout.write(chunk.payload?.text ?? '')
  }
  console.log('\n\n[part2] order after restart+approve:', JSON.stringify(order))
  const ok = order && typeof order === 'object' && 'orderId' in (order as object) && (order as { items?: unknown[] }).items?.length
  console.log(ok ? '\n[✓] gate survived the restart — order placed with cart intact' : '\n[✗] resumed but cart/order missing')
}
void main()
