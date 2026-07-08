import { Session, sessions } from '@/core/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/sessions { text, address } → { sessionId }
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { text?: string; address?: string }
  if (!body.text?.trim()) {
    return Response.json({ error: 'text is required' }, { status: 400 })
  }
  const session = new Session()
  sessions.set(session.id, session)
  // Kick off the run; the client watches progress over the SSE stream.
  void session.run({ text: body.text, address: body.address })
  return Response.json({ sessionId: session.id })
}
