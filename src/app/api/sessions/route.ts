import { Session, sessions } from '@/core/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/sessions { text, address?, location? } → { sessionId }
// `location` is the real coords captured by the calling client (web-UI browser
// geolocation, or the CLI --location flag) — the headless scraper has no GPS.
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    text?: string
    address?: string
    deliveryAddress?: string
    location?: { lat?: number; lon?: number }
    userId?: string
  }
  if (!body.text?.trim()) {
    return Response.json({ error: 'text is required' }, { status: 400 })
  }
  const loc = body.location
  const location =
    typeof loc?.lat === 'number' && typeof loc?.lon === 'number' ? { lat: loc.lat, lon: loc.lon } : undefined
  const deliveryAddress = typeof body.deliveryAddress === 'string' && body.deliveryAddress.trim() ? body.deliveryAddress.trim() : undefined
  const userId = typeof body.userId === 'string' && body.userId ? body.userId : undefined
  const session = new Session()
  sessions.set(session.id, session)
  // Kick off the run; the client watches progress over the SSE stream.
  void session.run({ text: body.text, address: body.address, deliveryAddress, location, userId })
  return Response.json({ sessionId: session.id })
}
