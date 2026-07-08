# faff Engineering Work Trial — Design Doc

**Author:** Biley
**Date:** 8 July 2026
**Status:** Design (pre-implementation) — **stack revised to Next.js + Mastra** (see §6, §11)

---

## 1. What this is actually testing

The brief asks for three 1-day builds — book a hyperlocal delivery (Uber/Rapido/Porter), reach a booking-ready home-services slot (Snabbit/Urban Company), and build a checkout-ready Blinkit cart from free text. But the load-bearing sentence is:

> *"Ideally, we want you to build the service that builds these. Reverse engineering a 4th app should be a piece of cake after this."*

So the deliverable is **not three scripts** — it is **one reusable harness with three thin adapters**, such that a 4th target is just a 4th adapter. Every decision below optimizes for that abstraction, plus the two things the brief explicitly grades: **judgment** (money/risk handling, right tool per target) and **a working end-to-end spine** over polish or breadth.

---

## 2. The core abstraction

Every one of the three problems is the same four-stage pipeline. The differences live only in stages 2–4, which is what makes them adapter-shaped.

**Interpret** — free text → typed intent. One agent call, shared across all three services. ("get me 2L milk to Koramangala" → `{ service: "quickcommerce", items: [...], address: "..." }`.)

**Resolve** — intent → target-specific identifiers. Geocode a messy address (P1), match text to SKUs with alternative/unavailable logic (P3), or find a concrete service + slot (P2).

**Drive** — execute against a target we don't own. Reverse-engineered API calls, browser automation, or a hybrid — chosen per target.

**Observe** — poll/stream state back. Ride tracking (P1), booking status (P2), cart/order state (P3).

These are four generic interfaces. Each app implements `Resolve` / `Drive` / `Observe`; `Interpret` is written once. A 4th app = implement three methods.

```
Free text ──▶ Interpret ──▶ Resolve ──▶ Drive ──▶ Observe ──▶ Events
              (shared)      (adapter)   (adapter)  (adapter)
```

In Mastra terms: **Interpret** is an agent call with structured output; **Resolve/Drive** are `createTool()` tools the agent calls inside a bounded loop; the irreversible step and **Observe** live in a **workflow** so the EXECUTE gate is a native suspend/resume (§5). The adapter interface is unchanged — a 4th app is still three methods.

---

## 3. Agentic controller

Per the decision to run the LLM as an agent throughout, the controller is a **bounded ReAct loop** — but with a strict discipline that keeps it reliable and gradeable:

**Agent decides, code executes, every decision is a typed + logged checkpoint.**

The LLM proposes the next action against a **constrained tool schema** — it never emits free-form HTTP. Deterministic adapter code performs the action and returns structured state. The agent keeps real autonomy over *choices* (which alternative SKU, which slot, how to recover from "out of stock"); the *effects* stay in code we can trust, replay, and grade.

Implemented as a **Mastra `Agent`** (`new Agent({ model, tools, instructions })`) whose tools are the shared surface below, each defined via `createTool()` with a Zod `inputSchema` (plain-object tools silently no-op in Mastra v1 — the factory is mandatory). Adapters implement the subset they support:

- `search_catalog(query)` → candidate items/services/routes
- `resolve_location(text)` → geocoded coordinates + confidence
- `add_to_cart(itemId, qty)` / `select_slot(slotId)` / `request_quote(route)`
- `get_state()` → current cart / slot / ride status
- `confirm(summary)` → **crosses the EXECUTE gate** (see §5)

Guardrails: hard **step cap** (`maxSteps`) + cost/token cap per run; **Mastra's built-in observability** records every agent step, tool call, input/output, token count and timing as a trace — this trace *is* half the teardown deliverable ("how you cracked each target"), viewable and replayable in **Mastra Studio**, no hand-rolled logging.

---

## 4. Interface: chat over a streaming API, two clients

The input is free-form text and the agent needs to ask clarifying questions, report progress, and stream live updates — so the surface is **conversational and streaming**, not a form. The API is the real deliverable; the clients are thin.

Everything runs as **one Next.js (App Router) app** with **Mastra in-process** — the route handlers import the Mastra instance directly, no separate agent server.

**Contract** (Next.js route handlers under `/api`):

- `POST /api/sessions` `{ text, address }` → `{ sessionId }` — starts a workflow run
- `GET /api/sessions/:id/stream` → **SSE** event stream (server→client push; built-in reconnect; far less code than WebSocket for a 1-day build)
- `POST /api/sessions/:id/message` `{ text }` → user replies to questions / approves the gate → resumes the run (`run.resume`)

**One typed event union** — same envelope for all three services (this is what keeps the harness generic). We map Mastra's stream chunks and workflow status onto it via custom stream data parts, so the clients never learn Mastra internals:

| Event | Meaning | Renders as |
|---|---|---|
| `agent_message` | NL narration | chat bubble |
| `question` | needs input, carries options | prompt / buttons |
| `action` | what it's doing now | live "thinking" line |
| `state_update` | structured cart / slot / ride payload | live card |
| `awaiting_confirmation` | the EXECUTE gate: amount + summary, blocks | Confirm / Cancel button |
| `done` / `error` | terminal | status |

The controller emits these events and doesn't know which client is listening. Interpret → `agent_message` + maybe `question`; Resolve/Drive → `action` + `state_update`; the EXECUTE gate → `awaiting_confirmation`, parking the workflow (a suspended step, §5) until approval arrives over `POST /message`. **The interface and the money-boundary are the same mechanism.**

**Two first-class clients, one stream:**

- **Web** — a Next.js React page: a message list, an input box, and small renderers (question→buttons, state_update→card, awaiting_confirmation→confirm). Consumes the SSE stream.
- **CLI** — a Node chat client hitting the same `/api` routes and rendering the identical event union. Kept as a first-class deliverable (great for development and demos), not just a fallback.

Because both clients consume the same typed stream, neither knows or cares that Mastra is underneath.

---

## 5. Guardrails: money and reliability

Since we're going all the way to real orders on all three, the two failure modes to design *around* are **money** and **account bans**.

**The EXECUTE gate.** Every adapter runs fully up to the final irreversible action (submit order / dispatch ride / confirm booking), then stops and requires an explicit approval to cross. Default is dry-run that stops one call short. This lets us demo the whole pipeline many times while paying once — and demonstrates exactly the judgment the brief grades.

Implemented as a **Mastra workflow suspend/resume**: the confirm step declares a `suspendSchema` + `resumeSchema` and calls `suspend()` when approval is missing; the run reports `status === 'suspended'`, which we surface as the `awaiting_confirmation` event; `run.resume({ step, resumeData: { approved } })` crosses the gate. Snapshots persist to the configured **storage adapter**, so a suspended gate **survives a process restart natively** — no hand-rolled recovery state machine. Crossing EXECUTE is a code gate, not an LLM whim (the agent only *proposes* `confirm`).

**Idempotency.** Every real transaction is guarded by a run-ID so a retry or crash never double-orders (the workflow run id is the natural key; the confirm step is written to execute at most once per run).

**Kill path.** The cancel flow is wired and tested *before* any `confirm` is ever sent — resuming the suspended gate with `{ approved: false }` must cleanly abort with nothing charged.

**Spend sequencing by risk.** Blinkit order first (cheapest, within the ₹1,000 reimbursement), then a home-services booking, then the delivery ride as the single most expensive shot — done once, last, on a short/cheap route, with cancel tested. A live ride is real money to a real driver and the target actively fights automation, so it gets the most caution.

**Reliability of the agent.** The constrained-tool pattern (§3) plus bounded loop (`maxSteps` + token cap) plus full trace keeps the "agentic throughout" choice from decaying into nondeterministic charges.

---

## 6. Stack

**TypeScript throughout**, one toolchain for browser-capture and API-replay so a captured request lifts straight into a typed client. All three targets are JS-heavy web/mobile apps, which makes this the natural fit.

- **Next.js (App Router)** — the whole runtime and UI in one app. Hosts the `/api` route handlers *and* the React web client, with **Mastra running in-process** (imported into the handlers, not a separate server). One deploy, one dev command.
- **Mastra v1.50** (agent framework) — three of its primitives map directly onto our design:
  - **`Agent` + `createTool`** — the bounded ReAct controller (§3), with `maxSteps` as the hard step cap.
  - **Workflow `suspend`/`resume`** *is* the EXECUTE gate (§5) — park the run, wait for approval, resume, and it **survives a process restart** because snapshots persist to storage. No hand-rolled state machine.
  - **Built-in observability + Mastra Studio** *is* the teardown log — every agent step, tool call, I/O, and token count is captured and replayable, and half the deliverable is *how* we cracked each target.
  - Also: TypeScript-native, Zod-native schemas (already our stage-boundary types), and built *on* the Vercel AI SDK, so streaming to the clients is first-class.
- **LLM via OpenRouter** — `@openrouter/ai-sdk-provider`; Mastra accepts a Vercel AI SDK model instance directly in `Agent.model` (and also supports `openrouter/<provider>/<model>` router strings), so we keep OpenRouter with **no capability loss**. Model id in the `MODEL` env; direct Anthropic is a fallback. *Note:* Anthropic's structured-output endpoint rejects `minimum`/`exclusiveMinimum` on integers — LLM-facing Zod schemas must express bounds in `.describe()` text, not constraints.
- **Storage — `@mastra/libsql`** (SQLite file) — persists workflow snapshots (gate durability) and traces. Lives outside the repo (gitignored), never committed.
- **Playwright** — browser automation for auth capture and browser-driven adapters.
- **Zod** — typed schemas at every stage boundary and for the tool surface.

**Escape hatch:** Mastra sits *on* the Vercel AI SDK, so if it ever gets in the way on a specific adapter we can drop to the AI SDK directly for that piece — no wall between them. This keeps the framework choice low-risk.

*Rejected:* **Fastify + hand-rolled SSE/gate/trace** — an earlier spike built exactly this and it worked, but Mastra provides the gate (suspend/resume), the trace (observability/Studio), and streaming natively, so the bespoke versions are redundant. **LangGraph** — its TS edition lags the Python one and it's heavier than this small agent core needs. *Caveat:* Mastra had no SOC 2 as of early 2026 — irrelevant for a take-home, not to be cited as production-hardened.

---

## 7. Approach per target (right tool per target = graded)

**Blinkit (P3) — reverse-engineered web/API first.** Conventional web storefront with internal JSON endpoints (catalog search, product, cart). Capture the network calls, replay with a typed HTTP client. Cleanest, most impressive path — cracking an API, not puppeting a browser. Playwright fallback ready for anything gated (bot checks, dynamic tokens). The interesting logic is SKU matching with "pick reasonable alternatives or flag unavailable."

**Home Services (P2) — hybrid, lean browser.** Availability is tightly coupled to the app flow, so drive it with Playwright to reach a real booking-ready slot, while sniffing the availability endpoint in parallel — promote to a direct API call if it's clean. Slot/availability is the payload extracted.

**Delivery (P1) — API capture with browser-assisted auth.** Needs a real authenticated session: use a browser to clear login/OTP once, capture the session, then hit booking + trip-status endpoints directly for the live "ride updates" loop. **Rapido or Porter over Uber** (Uber has the most aggressive anti-automation). Reach quote → confirm; dispatching the ride is the deliberate money-risk line.

---

## 8. Build order & rationale

Ordered to get the reusable core right where the blast radius is smallest, and to de-risk the schedule.

0. **Harness on Next.js + Mastra** — scaffold the app, wire Interpret (agent + structured output), the tool loop, the workflow gate (suspend/resume + storage), observability, and both clients against a **mock adapter**. Prove the spine (including a real restart across the gate) before any target work.
1. **Blinkit first** — the reference implementation. Lowest risk, exercises the full spine (text → SKU match → cart → checkout-ready). Get the adapter shape right here. If only one thing is polished, it's this.
2. **Home Services second** — validates the adapter abstraction survives a *second, different-shaped* target (slots/availability, not a cart). Booking-ready slot proves end-to-end without forcing spend.
3. **Delivery last** — hardest and riskiest; by now the harness is proven, so the remaining time budget goes to genuinely hard adapter work (auth capture, live tracking) instead of fighting the framework.

If the day runs out: Blinkit fully done, Home Services to booking-ready, Delivery to quote/confirm — which still demonstrates the whole spine plus honest risk judgment.

---

## 9. Deliverables checklist (from the brief)

- Running service — **Next.js app: React chat UI + `/api` streaming endpoints, plus a CLI client on the same stream.**
- Teardown per target — how each was cracked + edge cases hit "the hard way," sourced from **Mastra Studio traces**.
- This design doc.
- Good-citizen posture: respect rate limits, credentials out of the repo (env/secret store + gitignored storage), EXECUTE gate + cancel path to avoid runaway charges.

---

## 10. Open items to resolve during implementation

- Exact Blinkit internal endpoints + any dynamic token / signing scheme (discover via capture).
- Delivery target final pick (Rapido vs Porter) based on which auth + tracking is most tractable.
- Geocoding provider for P1 (managed API vs the target's own place-autocomplete endpoint).
- Whether Home Services availability endpoint is clean enough to promote from browser to API.
- Exact shape of the custom stream data parts that carry `question` / `awaiting_confirmation` / `state_update` over Mastra's stream to the clients.

---

## 11. Stack revision note (why Next.js + Mastra)

An initial spike built the harness on **Fastify + the Vercel AI SDK directly**, with a hand-rolled SSE layer, a custom suspend/resume gate (disk-backed checkpoint + restart recovery), idempotency guard, and a vanilla-HTML chat client. It worked end-to-end — including a `kill -9`-at-the-gate restart test — which de-risked the *design*.

We then revised the stack to **Next.js + Mastra v1.50** because Mastra provides, natively and more robustly, exactly the three things we had hand-rolled:

1. **The EXECUTE gate** → workflow suspend/resume with storage-backed snapshots (restart-durable by construction, not by our own recovery code).
2. **The teardown log** → built-in observability + Mastra Studio (a replayable trace UI, directly serving the graded "how you cracked each target" deliverable).
3. **Streaming + tool loop** → `Agent`/`createTool` on the AI SDK Mastra already sits on.

The move was made *before* any real adapter existed — the cheapest possible moment — and it makes the code match this design rather than deviate from it. OpenRouter is preserved (Mastra accepts our AI-SDK model instance). The earlier Fastify spike is preserved in git history / a backup bundle, not in the live tree.
