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
  - **Native tool approval** (`requireApproval` → `tool-call-approval` chunk → `approveToolCall`/`declineToolCall`) *is* the EXECUTE gate (§5) — the run parks before the irreversible tool executes, waits for approval, and **survives a process restart** because the approval snapshot (incl. `requestContext`) persists to storage. Simpler than the workflow wrapper we first assumed; no hand-rolled state machine. *(Implemented and verified with a `kill -9` restart.)*
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

---

## 12. Blinkit implementation plan (P3) — the reference adapter

The harness is proven (Phase 0 done: interpret → tool loop → native EXECUTE gate → restart-durable approve → order, over web + CLI, with traces). Blinkit is now just an `Adapter` that implements the same tool surface (`search_catalog`, `add_to_cart`, `get_state`, `confirm`) against real endpoints. Plan below; **items marked ⟨capture⟩ are confirmed from live network traffic, not assumed.**

### 12.1 Recon → capture (B1)

Blinkit's web app (`blinkit.com`) is a JS SPA that calls internal JSON APIs. The web flow is **location-first**: no catalog is served until a delivery location is set, because availability and pricing are per–dark-store. So the capture sequence mirrors a real order:

1. **Set location** → ⟨capture⟩ the geocode/serviceability call (address/latlng → store/merchant id + serviceability). Note where `lat`/`lon` live (query, headers, or body).
2. **Search a product** → ⟨capture⟩ the catalog-search endpoint: request shape (query, store id, pagination) and response (product id, name, `price`/`mrp`, `inventory`/availability, unit/variant, image).
3. **Open a product** → ⟨capture⟩ product-detail (may be optional if search returns enough).
4. **Add to cart** → ⟨capture⟩ the cart mutation: does it need auth? what item identifier (product id vs variant/merchant-product id)? request/response cart shape.
5. **View cart / checkout page** → ⟨capture⟩ cart-state read and the pre-payment checkout call (the last step *before* payment — this is our EXECUTE gate boundary).

For each: record method, URL, required **headers** (the interesting part — quick-commerce APIs gate on things like `lat`/`lon`, `app_client`/platform, a device/session id, and an `auth_key`/access token), query params, and body. Capture via the browser's network log; save a redacted HAR-style note into the teardown.

**Auth boundary ⟨capture⟩:** determine exactly where login is required. Hypothesis to confirm: browse + search + build cart may work as guest with just location + device headers; **placing the order** needs a logged-in session (phone + OTP). If so, only B4 (real order) needs auth — B1–B3 (checkout-ready cart, the graded core) may not.

### 12.2 Typed HTTP client (B2)

- A small `blinkitClient` (plain `fetch`, no SDK) that carries the ⟨capture⟩'d required headers, holds location (store id + latlng) and, if needed, the captured session token.
- One typed function per endpoint, Zod-validated response → our internal shape. Captured requests lift straight into this (the TS-throughout payoff).
- **Good-citizen:** a shared rate-limiter/backoff, realistic `User-Agent`, no parallel hammering. Credentials/token from env or a gitignored session file, never committed.

### 12.3 Adapter wiring (B3, B3a)

Map the client onto the `Adapter` tool impls (`ctx.sessionId` keys the cart, exactly like the mock):
- `search_catalog(query)` → search endpoint → `[{ id, name, price, inStock, unit }]`. **This is all the agent needs** — the substitution/unavailable logic already works (proven on the mock); it just consumes real results now.
- `add_to_cart(itemId, qty)` → cart mutation → updated cart state.
- `get_state()` → cart read → `{ items, total, currency }` (+ a checkout-ready **cart link** so a human can finish in-app even in dry-run).
- `confirm(summary)` → the pre-payment/checkout call, **behind the gate** (B4, bonus).

Location handling: the intent carries a free-text address; resolve it to Blinkit's store/latlng once at the start of the run (a `resolve_location`-style step or a first client call), then thread the store id through the client.

### 12.4 Order + fallback (B4, B5)

- **B4 (bonus, real spend):** cross the EXECUTE gate → the checkout call → stop one step short of payment if possible (a "cart link / order draft"), or place the cheapest real order within the ₹1,000 cap, **once**, with the cancel path checked first. Idempotent by `sessionId` (native — confirm runs once per approval).
- **B5 (fallback):** if any step is gated by bot-detection or a dynamic/signed token we can't replay cleanly, drive *that step* with Playwright (reuse a captured browser session) and keep the rest on the API. The adapter interface doesn't change — only the impl of the gated tool.

### 12.5 Teardown (B6)

Sourced from the Mastra traces + the ⟨capture⟩ notes: the endpoint map, the header/auth scheme we had to satisfy, and the edge cases hit "the hard way" (location-gating, auth boundary, any token signing, out-of-stock behaviour).

### 12.6 Open questions the capture must answer

- Exact search/cart endpoint URLs + the required header set (esp. any `auth_key`/token and how `lat`/`lon` are passed). ⟨capture⟩
- Guest vs. logged-in boundary — can a checkout-ready cart be built without login? ⟨capture⟩
- Item identity: single product id vs. variant/merchant-product id for cart adds. ⟨capture⟩
- Any anti-automation (Cloudflare, signed params, device attestation) that forces the Playwright fallback. ⟨capture⟩
- Is there a shareable **cart/checkout link** we can surface as the dry-run deliverable? ⟨capture⟩

## 13. Placing a real order (B4 bonus) — feasibility & risk map

The brief's bonus: *"Bonus points if you are able to place the order as well!"* We reach a checkout-ready cart **and** a live shareable cart link today (guest `POST /v1/assist/cart/share` → `link.blinkit.com/…` that renders "Items shared with you!" + Add-to-Cart). This section is the researched plan for going past that to an actually-*placed* order — deliberately a feasibility map, not a live paid run. Facts below are verified against primary sources (Blinkit's own Terms, Swiggy's MCP docs, Razorpay docs, RBI rules, mid-2025 reporting); see the [[blinkit-b4-place-order-research]] memory for the citation trail.

**Bottom line.** COD is the only clean path to a truly *placed* order with **no payment automation** — and it is exactly the path the one sanctioned precedent (Swiggy's official MCP) uses. Every online-payment rail in India ends in an **out-of-band human step** (UPI PIN inside the user's own app, or card OTP/3DS) *by RBI mandate* — so "fully autonomous pay" is neither achievable nor legal to fake. The defensible bonus = **COD behind the EXECUTE gate**, plus a **UPI-Intent/QR "human taps once"** handoff for prepaid.

### 13.1 Payment-path matrix

| Path | Agent can complete alone? | Blocker | Verdict |
|---|---|---|---|
| **Cash / Pay-on-delivery** | **Yes** (select COD → order-create) | *May be disallowed per order* | ✅ primary real-order path |
| **UPI (Intent/Collect)** | No | PIN entered in user's UPI app (always out-of-band) | ⚠️ semi-auto: agent triggers, human taps + PIN |
| **Cards** | No | RBI: no raw card-on-file; tokenization **+ AFA/OTP every charge** | ❌ needs human OTP |
| **UPI Autopay / e-mandate** | Partly (≤₹15k post-setup) | recurring-mandate rail, not one-off checkout; setup needs PIN | ❌ wrong shape for one order |
| **Prefunded wallet (Zomato/Blinkit Money)** | Maybe | balance must be pre-loaded (itself a real payment); non-withdrawable | 🟡 niche |
| **Agentic UPI (UPI Circle / Reserve Pay)** | Emerging "yes" | needs new Razorpay–NPCI rails + one-time delegated mandate | 🔭 future path our gate already fits |

### 13.2 Key findings

- **COD is real but conditional.** Blinkit's Terms verbatim accept *"…UPI, cash on delivery, or any other RBI approved payment mode… However, cash on delivery may not be permitted for certain orders."* So it's API-selectable but store/cart/risk-gated. Watch-out: q-commerce now adds a **~₹15+GST cash-handling fee disclosed only *after* you tap order** (Zepto, Jul 2025) → the agent must re-read the final payable amount post-select, not trust the pre-order total. **Login is required to place any order** — a guest cart cannot convert.
- **Online auto-pay is a (correct) dead end.** UPI PIN is always entered by the customer in their own app (Razorpay docs); cards need AFA/OTP every charge and can't be stored raw (RBI CoF rules, tightening to Apr 2026). Faking either = defeating India's two-factor mandate → hard no on legal + security grounds.
- **The sanctioned direction:** Razorpay + NPCI + OpenAI's **agentic-payments pilot** (ChatGPT, India; BigBasket first merchant) uses **UPI Circle / Reserve Pay** — user grants a **one-time authorization + spending cap**, then delegates, with real-time tracking + instant revocation. This maps 1:1 onto our **EXECUTE gate + ₹1,000 cap**.

### 13.3 Precedents (that validate our design)

- **Swiggy MCP** (official): real `place_food_order`; **session credentials auto-supplied** (agent never holds secrets); **COD-only**; **blocks carts ≥ ₹1,000**; **requires explicit user confirmation**; invite-only. Independently confirms our gate + cap + COD + no-secrets shape.
- **Zepto Cafe agent** (late 2025): **Playwright** as a delegated logged-in user, drives search→address→checkout — **stops at checkout, does not complete payment**; internal/experimental. Validates our Playwright vehicle *and* the payment boundary.
- **BigBasket × ChatGPT:** UPI via Razorpay with a **single human confirmation** — the semi-auto handoff again.

### 13.4 Legal / ToS / risk (first-class — a grading axis)

Blinkit Terms **prohibit automated/bot access** (unauthorized use auto-terminates the license); Zomato ToS restricts data to **personal, non-commercial use** and bars automated access absent written agreement; the only sanctioned Zomato API is restaurant "Licensed Content" (no ordering/checkout/payment) — so *any* Blinkit order placement rides undocumented internal endpoints, outside ToS. Blinkit may ban users it *suspects* of ToS/fraud at sole discretion. **Defensible posture** (what the teardown states): user-consented, **the user's own account + own money**, one **gated, capped, cancellable, idempotent, rate-limited** order, no credentials in the repo — an agent acting for a consenting user, not a commercial scraper. Residual risk is stated, not hidden.

### 13.5 Plan (no spend now)

1. Wire **COD** behind the existing gate: after login, `create-order` with `payment_method = COD`, **stop at order-create** now; re-read the post-select total (cash-handling fee).
2. Keep the **share link + a UPI-Intent/QR handoff** as the prepaid option ("agent builds cart → you tap Pay once").
3. **Cancel path first:** capture + test the cancel endpoint *before* ever calling create-order.
4. Cite the **agentic-UPI** model as the future path the gate already fits.

**Unknowns we'd still capture ourselves** (public info thin): (a) Blinkit's **checkout/order-create** endpoint + payload and payment-method selection call; (b) whether **COD is offered for our store/cart** at runtime (read from the checkout response); (c) the **cancel-order** endpoint (capture before any create); (d) which **gateway** backs main checkout (Razorpay is confirmed only for *Blinkit Money* PPI).

## 14. Home Services implementation plan (P2) — the second, different-shaped adapter

Snabbit is app-only (no web surface to reverse-engineer), so the target is **Urban Company** (`urbancompany.com`) — a location-first JS SPA, the same shape as Blinkit. But the *graded deliverable is different*, and that difference is the point of P2: it proves the adapter abstraction survives a target that is **slots/availability, not a cart**.

- Blinkit's core = **checkout-ready cart** (Resolve = text→SKU).
- UC's core = **booking-ready slot** (Resolve = need→service **+ a concrete available time slot + address**), stopped one call short of payment. This is exactly the §8 fallback line ("Home Services to booking-ready"), and it makes `select_slot` — the tool Blinkit never used — the centerpiece.

**Scope decision (locked):** the deliverable is **booking-ready-slot with no spend**. A real paid booking (H4) is *out of scope* as a live run — most UC services (deep cleaning ~₹1,500+) exceed the ₹1,000 cap, and a booking dispatches a real professional to a real home at a real time (higher real-world consequence than a grocery order). If H4 is ever wired, it stops at the pre-payment step behind the gate, with the cancel path captured and tested first — never an actual dispatch. Items marked ⟨capture⟩ are to be confirmed from live traffic, not assumed.

### 14.1 The flow to reverse-engineer (H1)

Location-first, like Blinkit — no availability is served until a location is set (per-city, per-service-area pro supply):

```
set location → browse category ("cleaning") → pick a service/package
   → (availability) date + time-slot selection   ← the H-specific payload
   → address confirm → login → payment
```

The **booking-ready** stop point = service selected + a concrete slot held + address set, one call short of payment.

Capture sequence mirrors a real booking:
1. **Set location** → ⟨capture⟩ the serviceability/area call (address/latlng → serviceable + city/area id). Note where lat/lon live.
2. **Browse a category / search a need** → ⟨capture⟩ the service-catalog endpoint: request shape + response (service/package id, name, price, duration, rating).
3. **Open a service** → ⟨capture⟩ package/detail (may be optional if listing returns enough).
4. **Reach the slot screen** → ⟨capture⟩ **the availability endpoint** — date + time-window list, and the slot identifier we pass to `select_slot`. *This is the graded payload.*
5. **Address + the pre-payment step** → ⟨capture⟩ the last call before payment (our EXECUTE-gate boundary) and whether a **resumable booking link** exists (the dry-run deliverable, like Blinkit's checkout link).

For each: method, URL, required headers, query, body. Save a redacted note into the teardown.

**Auth boundary ⟨capture⟩:** hypothesis to confirm — browse + service-select + reach slots may work as guest; **login (phone+OTP) is forced before payment** (possibly before slot-hold). If login is later than slot-hold, the entire graded core needs no auth.

**Bot management ⟨capture⟩:** does UC sit behind Cloudflare/Akamai like Blinkit? If yes, reuse the proven **Playwright-as-TLS-vehicle** technique and the engine-backed **identity pool** (`src/adapters/blinkit/identities.ts`, worth factoring into a shared module at that point).

### 14.2 Transport decision (H2) — genuinely browser-driven, sniff-to-promote

Per §7, UC is expected to be more genuinely **browser-driven** than Blinkit, because availability is coupled to the app flow:
- Drive the **DOM with Playwright** to reach the slot screen reliably (survives whatever gating exists).
- **Sniff the availability endpoint in parallel** — if it's a clean JSON call, **promote `select_slot` to a direct API call** (§10 open item). Same "promote if clean" bet we made on Blinkit search; if it's messy/signed, keep it DOM-driven.

### 14.3 Adapter wiring (H3, H3a) — maps onto the shared `AdapterTools`

- `configureLocation`/`suggestLocations`/`pinLocation` — UC is location-gated; reuse the location-first pattern (current-loc default + area autocomplete fallback).
- `search_catalog(query)` → service-catalog → `[{ id, name, price, duration, rating }]`. Resolve = need→service (the agent picks the right package, e.g. "deep cleaning" → the matching UC package), reusing the same substitution/selection logic already proven on the mock + Blinkit.
- `select_slot(slotId)` → hold/select a date + time window — **the new payload the abstraction is being tested against.**
- `get_state()` → `{ service, slot, price, address, bookingUrl }` — the booking-ready summary + a resumable link so a human can finish in-app.
- `confirm(summary)` → behind the EXECUTE gate; in scope it finalizes **booking-ready** (no spend), like Blinkit's `confirm` finalizes checkout-ready.

### 14.4 Teardown (H5)

From the session traces + ⟨capture⟩ notes: the endpoint map (esp. the availability endpoint), the auth boundary, any bot management we had to satisfy, whether availability was promotable to API, and the edge cases hit the hard way (location-gating, slot-hold semantics, app-punt if UC forces the mobile app for any step).

### 14.5 Open questions the capture must answer

- Does UC web support the full flow to **slot-hold**, or does it punt to the mobile app at some step? ⟨capture⟩
- Service-catalog + **availability** endpoint URLs + shapes; is availability clean enough to promote to API? ⟨capture⟩
- Exact **auth boundary** — is login forced before slot-hold or only before payment? ⟨capture⟩
- Any **anti-automation** (Cloudflare/Akamai/signed params) forcing the identity-pool vehicle. ⟨capture⟩
- Is there a **resumable booking link** we can surface as the dry-run deliverable? ⟨capture⟩
