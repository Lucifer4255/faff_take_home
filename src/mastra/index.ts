import { Mastra } from '@mastra/core'
import { LibSQLStore } from '@mastra/libsql'
import type { Adapter } from '@/core/adapter'
import { blinkit } from '@/adapters/blinkit'
import { delivery } from '@/adapters/delivery'
import { homeservices } from '@/adapters/homeservices'
import { mockQuickcommerce } from '@/adapters/mock/quickcommerce'
import { buildAgent, interpreter } from './agents'

/** MOCK_ADAPTERS=1 swaps the real quick-commerce adapter for the deterministic
 * mock so the whole spine (incl. the EXECUTE gate + restart) is testable
 * without touching a real target. */
const quickcommerce: Adapter = process.env.MOCK_ADAPTERS === '1' ? mockQuickcommerce : blinkit
export const ADAPTERS: Adapter[] = [quickcommerce, homeservices, delivery]

const serviceAgents = Object.fromEntries(
  ADAPTERS.map((a) => [`${a.service}-agent`, buildAgent(a)]),
)

export const mastra = new Mastra({
  agents: { interpreter, ...serviceAgents },
  // Snapshots for tool-approval (the EXECUTE gate) + traces persist here, so a
  // suspended gate survives a process restart (DESIGN.md §5).
  storage: new LibSQLStore({ id: 'faff', url: process.env.MASTRA_DB_URL || 'file:./.data/mastra.db' }),
})

/** The controller agent id for a given service. */
export function agentIdFor(service: string): string {
  return `${service}-agent`
}

/** Fetch the controller agent for a service. The id is computed at runtime, so
 * we bypass Mastra's literal-id typing here. */
export function controllerAgent(service: string) {
  return mastra.getAgentById(agentIdFor(service) as never)
}
