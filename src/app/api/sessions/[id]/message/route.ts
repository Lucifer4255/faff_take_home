import { getOrRecover } from '@/core/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/sessions/:id/message { text } — replies to questions / approves the
// gate (recovers a pending gate after a server restart)
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const session = getOrRecover(id)
  if (!session) return Response.json({ error: 'no such session' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { text?: string }
  if (!body.text?.trim()) return Response.json({ error: 'text is required' }, { status: 400 })
  await session.handleMessage(body.text)
  return Response.json({ ok: true })
}
