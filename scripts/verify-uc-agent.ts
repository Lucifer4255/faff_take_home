/**
 * Verify the REAL Urban Company home-services adapter end-to-end through the
 * harness: interpret → controller tool loop → live discoverySearch (Playwright
 * TLS vehicle) → select service + earliest slot → EXECUTE gate → approve →
 * booking-ready handoff. Guest, no auth, no spend.
 *
 * Run: npx tsx scripts/verify-uc-agent.ts
 */
process.env.MOCK_ADAPTERS = '0'
import { loadDotEnv } from '../src/core/env'
loadDotEnv()
process.env.MOCK_ADAPTERS = '0'

import { randomUUID } from 'node:crypto'
import { RequestContext } from '@mastra/core/di'
import { closeClient } from '../src/adapters/homeservices'
import { interpret } from '../src/mastra/agents'
import { agentIdFor, controllerAgent } from '../src/mastra/index'

// biome-ignore lint: structural stream type at this boundary
async function pump(stream: any, label: string): Promise<{ approvalRunId?: string }> {
  let approvalRunId: string | undefined
  for await (const chunk of stream.fullStream) {
    const p = chunk.payload ?? {}
    switch (chunk.type) {
      case 'text-delta':
        process.stdout.write(p.text ?? chunk.text ?? '')
        break
      case 'tool-call':
        console.log(`\n  · tool-call ${p.toolName} ${JSON.stringify(p.args ?? {})}`)
        break
      case 'tool-result':
        console.log(`  · tool-result ${JSON.stringify(p.result ?? p).slice(0, 260)}`)
        break
      case 'tool-call-approval':
        approvalRunId = chunk.runId ?? p.runId ?? stream.runId
        console.log(`\n  ⚠ [${label}] GATE tool-call-approval: ${p.toolName} args=${JSON.stringify(p.args)}`)
        break
      case 'error':
        console.log(`\n  ✗ error ${JSON.stringify(p.error ?? p)}`)
        break
    }
  }
  return { approvalRunId }
}

async function main() {
  const sessionId = randomUUID()
  const req = 'book a full home deep cleaning for tomorrow morning in Bangalore'

  console.log(`\n[1] interpret: ${req}`)
  const intent = await interpret(req)
  console.log('    →', JSON.stringify(intent))

  const agent = controllerAgent(intent.service)
  console.log(`\n[2] stream ${agentIdFor(intent.service)} (sessionId=${sessionId.slice(0, 8)})`)
  const stream = await agent.stream(`Typed intent (already parsed):\n${JSON.stringify(intent, null, 2)}`, {
    requestContext: new RequestContext([['sessionId', sessionId]]),
    maxSteps: 25,
  })
  const { approvalRunId } = await pump(stream, 'initial')

  if (approvalRunId) {
    console.log(`\n[3] approving gate (runId=${String(approvalRunId).slice(0, 8)}) …`)
    const approved = await agent.approveToolCall({ runId: approvalRunId })
    await pump(approved, 'after-approve')
    console.log('\n[✓] gate approved → booking-ready handoff produced from LIVE Urban Company')
  } else {
    console.log('\n[!] never reached the approval gate — check tool loop / instructions')
  }
}

void main()
  .catch((e) => {
    console.error('\nVERIFY FAILED:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeClient()
    process.exit(process.exitCode ?? 0)
  })
