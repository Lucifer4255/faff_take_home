import { getOrRecover } from '@/core/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/sessions/:id/location { address } — set/override the delivery address
// mid-session (a custom address, resolved via the current service adapter). The
// confirmation streams back over the SSE channel.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params
  const session = getOrRecover(id)
  if (!session) return Response.json({ error: 'no such session' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { address?: string }
  if (!body.address?.trim()) return Response.json({ error: 'address is required' }, { status: 400 })
  await session.setDeliveryArea(body.address.trim())
  return Response.json({ ok: true })
}
