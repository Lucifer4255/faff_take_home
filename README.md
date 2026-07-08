# faff harness

One reusable agentic harness + three thin adapters (Blinkit, home services, hyperlocal delivery), built on **Next.js + Mastra**. See `DESIGN.md` for the full design (§6 and §11 cover the stack); `architecture.svg` for the picture.

> **Status:** stack revised to Next.js + Mastra v1.50; app is being scaffolded. An earlier Fastify + Vercel-AI-SDK spike proved the design end-to-end and is preserved in a backup bundle (see §11).

## Target layout

```
src/
  mastra/          the Mastra runtime (in-process)
    index.ts         Mastra instance: agent, workflow, storage, observability
    agents/          the Interpret + ReAct controller agent
    tools/           the shared constrained tool surface (createTool)
    workflows/       the EXECUTE-gate workflow (suspend/resume)
  core/            framework-agnostic harness pieces
    events.ts        typed event union (the stream contract)
    intent.ts        Interpret output schema
    adapter.ts       Resolve/Drive/Observe adapter interface
  adapters/        one folder per target — a 4th app is a 4th folder
    blinkit/  homeservices/  delivery/
  app/             Next.js App Router
    api/sessions/…   POST /api/sessions · GET /api/sessions/:id/stream (SSE) · POST /api/sessions/:id/message
    (chat)/          React chat client
  cli.ts           CLI chat client over the same /api stream
```

Both the **web** page and the **CLI** are first-class clients of the same typed event stream.

## Run

```sh
cp .env.example .env   # add OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) + MODEL
npm install
npm run dev            # Next.js app (web UI + /api)
npm run cli -- "get me 2L milk and bread to Koramangala 5th block"
```

Workflow snapshots + traces persist to a local libSQL/SQLite store (gitignored). View runs and per-target teardown traces in **Mastra Studio**.

## Guardrails

Nothing irreversible happens without crossing the EXECUTE gate: the run parks at
`awaiting_confirmation` (a suspended workflow step) and only an explicit approval
resumes it. The gate is restart-durable (snapshots persist to storage). Credentials
live in `.env` / captured browser state outside the repo, never committed.
