import { z } from 'zod'

export const Service = z.enum(['quickcommerce', 'homeservices', 'delivery'])
export type Service = z.infer<typeof Service>

/**
 * Interpret output (DESIGN.md §2): free text → typed intent.
 * One schema shared across all three services; the discriminant routes to an adapter.
 */
export const Intent = z.discriminatedUnion('service', [
  z.object({
    service: z.literal('quickcommerce'),
    items: z.array(
      z.object({
        query: z.string().describe('what the user asked for, e.g. "2L milk"'),
        // no numeric range constraints here: this schema is sent to the LLM as
        // a structured-output format, and Anthropic rejects minimum/
        // exclusiveMinimum on integers there
        qty: z.number().int().default(1).describe('quantity, at least 1'),
      }),
    ),
    address: z.string().describe('delivery address as given, may be messy'),
  }),
  z.object({
    service: z.literal('homeservices'),
    need: z.string().describe('service needed, e.g. "deep cleaning", "instant helper"'),
    when: z.string().describe('requested time, as given'),
    location: z.string(),
  }),
  z.object({
    service: z.literal('delivery'),
    pickup: z.string().describe('pickup address as given, may be messy'),
    drop: z.string().describe('drop address as given, may be messy'),
    notes: z.string().optional(),
  }),
])
export type Intent = z.infer<typeof Intent>
