import { sessions } from '@/core/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/sessions/:id/stream → SSE event stream (replays history on connect)
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const session = sessions.get(id)
  if (!session) return new Response('no such session', { status: 404 })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = session.subscribe((event) => {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      })
      req.signal.addEventListener('abort', () => {
        unsubscribe()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
