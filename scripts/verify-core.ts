/**
 * Verify the Mastra core end-to-end WITHOUT the HTTP layer:
 * interpret → service agent tool loop → EXECUTE gate (tool approval) → order.
 * Run: MOCK_ADAPTERS=1 npx tsx scripts/verify-core.ts
 */
import { randomUUID } from 'node:crypto'
import { loadDotEnv } from '../src/core/env'
async function pump(stream: any, label: string): Promise<{ approvalRunId?: string; toolCallId?: string }> {
  let approvalRunId: string | undefined
  let toolCallId: string | undefined
  for await (const chunk of stream.fullStream) {
    const t = chunk.type
    if (t === 'text-delta') process.stdout.write(chunk.payload?.text ?? chunk.text ?? '')
    else if (t === 'tool-call') console.log(`\n  · tool-call ${chunk.payload?.toolName} ${JSON.stringify(chunk.payload?.args ?? {})}`)
    else if (t === 'tool-result') console.log(`  · tool-result ${JSON.stringify(chunk.payload?.result ?? chunk.payload ?? {}).slice(0, 160)}`)
    else if (t === 'tool-call-approval') {
      approvalRunId = stream.runId ?? chunk.payload?.runId
      toolCallId = chunk.payload?.toolCallId
      console.log(`\n  ⚠ [${label}] tool-call-approval: ${chunk.payload?.toolName} args=${JSON.stringify(chunk.payload?.args)}`)
    } else if (t === 'tool-call-suspended') console.log(`\n  ? tool-call-suspended ${JSON.stringify(chunk.payload)}`)
    else if (t === 'finish') console.log(`\n  ✓ [${label}] finish (${chunk.payload?.finishReason ?? '?'})`)
    else if (t === 'error') console.log(`\n  ✗ error ${JSON.stringify(chunk.payload ?? chunk.error)}`)
  }
  return { approvalRunId, toolCallId }
}

async function main() {
  loadDotEnv()
  process.env.MOCK_ADAPTERS = '1'
  const { agentIdFor, controllerAgent } = await import('../src/mastra/index')
  const { interpret } = await import('../src/mastra/agents')

  const sessionId = randomUUID()
  const req = 'get me 2L milk, a loaf of bread and some butter to Koramangala 5th block'
  console.log(`\n[1] interpret: ${req}`)
  const intent = await interpret(req)
  console.log('    →', JSON.stringify(intent))

  const agent = controllerAgent(intent.service)
  console.log(`\n[2] stream ${agentIdFor(intent.service)} (sessionId=${sessionId.slice(0, 8)})`)

  const { RequestContext } = await import('@mastra/core/di')
  const stream = await agent.stream(
    `Typed intent (already parsed):\n${JSON.stringify(intent, null, 2)}`,
    { requestContext: new RequestContext([['sessionId', sessionId]]), maxSteps: 25 },
  )
  const { approvalRunId } = await pump(stream, 'initial')

  if (approvalRunId) {
    console.log(`\n[3] approving gate (runId=${String(approvalRunId).slice(0, 8)}) …`)
    const approved = await agent.approveToolCall({ runId: approvalRunId })
    await pump(approved, 'after-approve')
    console.log('\n[✓] gate approved, run completed')
  } else {
    console.log('\n[!] never reached the approval gate — check tool loop / instructions')
  }
}
void main()
