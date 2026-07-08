import { z } from 'zod'

/**
 * The one typed event union (DESIGN.md §4). Every service speaks this envelope;
 * the controller emits it without knowing whether a browser, CLI, or test
 * harness is listening. Mastra stream chunks + tool-approval state are mapped
 * onto this union so the clients never learn Mastra internals.
 */
export const AgentEvent = z.discriminatedUnion('type', [
  // NL narration → chat bubble
  z.object({ type: z.literal('agent_message'), text: z.string() }),
  // needs user input, may carry options → prompt / buttons
  z.object({
    type: z.literal('question'),
    text: z.string(),
    options: z.array(z.string()).optional(),
  }),
  // what the agent is doing right now → live "thinking" line
  z.object({ type: z.literal('action'), label: z.string() }),
  // structured cart / slot / ride payload → live card
  z.object({ type: z.literal('state_update'), state: z.unknown() }),
  // the EXECUTE gate: blocks until approval arrives over POST /message
  z.object({
    type: z.literal('awaiting_confirmation'),
    summary: z.string(),
    amount: z.number().optional(),
    currency: z.string().optional(),
  }),
  z.object({ type: z.literal('done'), summary: z.string().optional() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type AgentEvent = z.infer<typeof AgentEvent>
