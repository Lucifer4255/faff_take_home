# A Unified Approach Across Services — what can be shared, what can't, and how a 4th app plugs in

**Companion to DESIGN.md.** DESIGN.md documents how each of the three targets was actually built (Blinkit §12–13, Urban Company §14, Uber §15). This file steps back and asks the question the brief is really testing: *given that the flow is visibly different for every service, is there one under-the-hood approach they all run through — such that a 4th app is a drop-in, not a rewrite?*

Short answer: **yes for the lifecycle and the outcome contract; no for the transport and the checkout mechanism — and that split is the whole design.** The honest version of "unified" is not *one flow*. It is **one lifecycle + one outcome contract, with the genuinely-varying parts isolated behind a small library of named strategies.**

---

## 1. The objection this document has to answer

The three services reach checkout in ways that do not look alike at all:

| | how it reaches checkout | who takes the final step | handoff artifact |
|---|---|---|---|
| **Blinkit** | an API call (`createSharedCart`) | human | a **URL** (`link.blinkit.com/…`) |
| **Urban Company** | an **LLM agent drives the DOM** to an enabled "Proceed to pay" | human | an **open Chrome window** on this machine — no link exists |
| **Uber** | clicks Uber's own "Request" button | **the agent** (crosses the money line) | none — the ride is dispatched, tracking begins |

You cannot collapse these into one mechanism. Blinkit *has* a shareable link because Blinkit's API mints one; UC has no such endpoint and never will; Uber doesn't need one because it actually executes. Forcing a single mechanism would mean inventing a link UC can't produce, or refusing to let Uber execute.

So "unify the services" **cannot** mean "make them check out the same way." The transport of the final step is irreducibly per-target. The trick is to find the layer *above* the transport that genuinely is the same — and stop unifying there.

---

## 2. What genuinely IS the same: one six-step lifecycle

Strip the domain nouns away and all three targets are the same lifecycle. The "cart vs slot vs ride" difference — which feels like the big variation — is actually the *least* important axis: it's just what you put in the basket.

| Step | Blinkit | Urban Company | Uber |
|---|---|---|---|
| **1. Locate** | dark-store from lat/lon | nearest metro (haversine) | pickup place id |
| **2. Auth** (per-user, human-in-loop) | phone + OTP → token inject | human clears Turnstile → cookies | human OTP → Chrome profile |
| **3. Search** | product search | `discoverySearch` | `pudoLocationSearch` |
| **4. Stage** (build the draft) | add items to cart | pick package + slot | pick pickup/drop + ride option |
| **5. Confirm** (behind the EXECUTE gate) | share cart / COD | drive to "Proceed to pay" | `TripRequest` |
| **6. Observe / Cancel** | order state | — | `GetStatus` / cancel |

Every target walks these six steps in this order. The harness already owns the orchestration of them (`core/session.ts`): it pins location, runs the login gate after gate-approval, runs the agent tool-loop, and streams `observe`. **The lifecycle is the unification.** It exists today; it just isn't named as the contract.

---

## 3. What varies: three orthogonal strategy axes

The real variation between targets is not the domain. It's that each target independently picks a value on **three orthogonal axes**. DESIGN.md §15.6 already states the thesis ("Blinkit replays; Uber listens; UC drives an agent — three transports behind one interface"); this is that thesis, generalized to all three axes and turned into a library.

### Axis A — Transport (how you touch the target)

| Strategy | Use when | Proven on |
|---|---|---|
| `apiReplay` | the payload is self-contained; you can forge the request from a capture | Blinkit |
| `browserListen` | the payload contains server-minted opaque tokens (fare token, payment profile) you can't forge — so *ride the app's own call* and read the response | Uber |
| `agentDrive` | the UI shape varies per category and there's no clean endpoint — an LLM reads the live a11y tree and fills whatever modal it finds | Urban Company |

All three sit on the **same substrate**: a real browser as the TLS vehicle (`page.evaluate(fetch)`), which is what gets past Cloudflare uniformly. The strategy is *what you do inside that browser*, not the browser itself.

### Axis B — Auth (how a session is established)

| Strategy | Mechanism | Proven on |
|---|---|---|
| `guest` | no login; location + device headers only | Blinkit browse/cart, UC search, Uber Tier A |
| `tokenInject` | human OTP → captured bearer token injected per request | Blinkit order |
| `profileSession` | human clears the wall once → persistent per-`userId` browser profile *is* the account | UC (Turnstile), Uber (OTP) |

Every one of these ends in the **same shape**: a human clears a wall once, and the adapter rides the resulting session, keyed by `userId`, never a global/most-recent session. The login *orchestration* (`needsLogin` → `sendLoginCode` → `verifyLoginCode`, gated in `session.ts`) is already shared; only the wall differs.

### Axis C — Terminal move (what `confirm` actually does)

| Strategy | Meaning | Proven on |
|---|---|---|
| `handoff:link` | mint a resumable URL, human pays in-app | Blinkit |
| `handoff:live-session` | leave a driven window open on the enabled pay button | Urban Company |
| `execute` | cross the money line for real | Uber |

**This is the axis the objection in §1 is about.** It is real, and it stays per-target. What §5 below shows is that although the *mechanism* is per-target, the *outcome shape* is not — and the outcome shape is the only thing the harness, the event stream, and the UI need to know.

> **A 4th service is not "a new shape." It is a new *combination* of values on these three axes** — most of which already exist in the library.

---

## 4. Why plug-and-play doesn't quite work today

The `Adapter` interface (`core/adapter.ts`) is sound. The friction is that a 4th service currently forces edits in **five files outside its own directory**, because the core knows too much about the specific services:

1. `src/core/intent.ts` — `Service` is a closed `z.enum`; `Intent` is a hand-written discriminated union.
2. `src/mastra/agents.ts` — `GOALS` is a `Record<Service, string>`, `instructions()` is an if/else ladder per service, and the interpreter has its own hardcoded service list.
3. `src/mastra/index.ts` — the `ADAPTERS` array.
4. `src/mastra/tools.ts` — `SCHEMAS`/`DESCRIPTIONS` if the target needs a verb that doesn't exist yet.
5. `src/core/session.ts` — ~15 sites of `adapter?.configureLocation?.()`, `adapter?.needsLogin?.()`, `adapter?.observe`, etc. — the core *interrogating* each adapter about what it can do by poking at `undefined`.

Two smells leak target-specific vocabulary into places that should be generic:

- `session.ts` branches on an **Uber-specific string**: `if (result.status === 'dispatched') this.dispatched = true` (to decide whether to start tracking).
- `chat.tsx` branches on a **UC-specific string**: `c.status === 'ready-to-pay'`, plus it sniffs `checkoutUrl` (which UC deliberately sets to `null`).

Across the three adapters, `confirm` returns **nine different status strings** (`cart-shared`, `checkout-ready`, `ready-to-pay`, `booking-ready`, `dispatched`, `not-dispatched`, `unavailable`, `needs-login`, `empty`) for what are really **four outcomes**. Nobody wrote the contract down, so each adapter improvised its own vocabulary, and the core + UI grew hardcoded knowledge of specific strings. *That* is the plug-in tax — not the transports.

---

## 5. The unification that IS possible: one typed Outcome contract

Keep every adapter's weird per-target drive exactly as it is. Just make `confirm` end by returning **one typed union**, and make the harness branch on the *kind*, never on a per-target string.

```ts
type Outcome =
  | { kind: 'executed';   draft: Draft; ref?: string }        // money crossed → observe + cancel
  | { kind: 'handoff';    draft: Draft; via: Handoff }        // human finishes → render it
  | { kind: 'blocked';    draft: Draft; reason: string }      // unserviceable / no slots / drive failed
  | { kind: 'needs-auth'; draft: Draft }                      // login gate not satisfied

type Handoff =
  | { as: 'link';         url: string }        // Blinkit shared cart
  | { as: 'live-session'; where: string }      // UC: "a Chrome window is open on this machine"
  | { as: 'instructions'; steps: string[] }    // whatever service #4 needs
```

And one generic staged-order type — which is what all three `get_state`s already return, differently named. A cart, a slot booking, and a ride are the *same object*: line items, a total, a resumable link, a readiness flag.

```ts
interface Draft {
  ready: boolean
  lines: Array<{ id: string; label: string; qty?: number; price?: number; meta?: unknown }>
  total?: { amount: number; currency: string }
  when?:  { label: string; iso?: string }      // UC slot, Uber ETA
  where?: { pickup?: Place; drop?: Place; address?: string }
  handoffUrl?: string
  note: string
}
```

Now the core's rules mention **no target**:

- `kind === 'executed'` → start `observe()`, enable `cancel()`. *(Replaces the hardcoded `'dispatched'` check in `session.ts`.)*
- `kind === 'handoff'` → render by `via.as`: a link is a button, a live-session is an instruction card. *(Replaces the `'ready-to-pay'` check and `checkoutUrl` sniffing in `chat.tsx`.)*
- `kind === 'blocked' | 'needs-auth'` → plain message, nothing charged.

And it buys an **invariant the harness can now enforce, not just hope for:** money is crossed **only** by `kind: 'executed'`. Every other outcome is *provably* a no-spend path. Today that guarantee is held together by nine strings and discipline; the union makes it a compiler check.

The mechanism stays local (Blinkit still calls `createSharedCart`, UC still runs the browser agent, Uber still clicks Request). Only the *outcome* is shared. That is the precise answer to §1:

> **The path to checkout is per-target and always will be. The *outcome* of checkout is universal — and that outcome is the only thing the harness, the event stream, and the UI are allowed to know about.**

---

## 6. The plug-in shape: a self-describing adapter + capability registry

Invert the dependency so the core stops knowing the list of services. Each adapter declares everything about itself — including its intent schema and its prompt — and a registry assembles the union.

```ts
export const uber = defineAdapter({
  service: 'delivery',
  intent: z.object({ pickup: z.string(), drop: z.string(), notes: z.string().optional() }),
  goal:  'Get a concrete quote for the pickup → drop route…',
  rules: ['- A wrong pickup sends a real driver to the wrong door: never guess an address.'],
  capabilities: ['locate', 'auth', 'search', 'stage', 'confirm', 'observe', 'cancel'],
  transport: browserListen({ origin: 'm.uber.com', ops: ['Products', 'TripRequest', 'GetStatus'] }),
  auth:      profileSession({ loginUrl: 'https://auth.uber.com/v2/', humanStep: true }),
  terminal:  execute(),        // vs handoffLink() / handoffLiveSession()
  // …hooks (parse.ts stays pure: response → Draft)
})
```

- `Service` becomes `keyof typeof REGISTRY`; `Intent` is a union *derived* by mapping over the registry.
- `agents.ts` builds instructions from `goal + rules + COMMON` — no more per-service if/else.
- **Capabilities as data** (`['locate','auth','observe','cancel']`) replace the `adapter?.x?.()` probing in `session.ts`. A missing capability is a *typed absence*, not an `undefined` you must remember to guard. (This is the standard capability-registry shape — e.g. OpenClaw's plugin architecture registers capabilities into a central registry the same way, so the host never grows an if-ladder per plugin.)

**Adding a 4th service then looks like one directory + one registry line:**

```
src/adapters/<newservice>/
  index.ts   ← defineAdapter({...}): intent schema, goal, capabilities, hooks
  client.ts  ← pick a transport strategy (replay | listen | agentDrive | partnerApi)
  parse.ts   ← pure: response → Draft
```

Everything else — the EXECUTE gate, the SSE event union, login orchestration, location pinning, tracking, cancel, traces, both clients — comes for free.

**What NOT to over-abstract:** don't turn `Draft` into a deep taxonomy or the transports into a plugin framework with lifecycle hooks. The value is *three strategies and six steps*, discovered by building three real targets. A 4th target may need a *fourth* transport (a mobile-capture rig for Rapido, say) — the registry should make that a new strategy module, not a fight with the abstraction.

---

## 7. The one axis a unified harness still can't paper over: the checkout *ceiling*

There is a fourth strategy axis that this document would be dishonest to omit, because it's the ceiling every reverse-engineered adapter hits: **whether payment can happen inside our app at all.**

All three current adapters stop at a handoff. That is **not** an engineering gap — it is the **legal ceiling of the "drive the user's own account" model**:

- **Login** in-app is technically doable (user pastes OTP → we submit) but it's a treadmill (UC's Turnstile already blocks it; device attestation is next) and against ToS.
- **Payment** in-app is a **hard wall by regulation.** RBI's *Authentication Mechanisms for Digital Payment Transactions* directions (issued 25 Sep 2025, **mandatory from 1 Apr 2026**) require an Additional Factor of Authentication on essentially all customer-initiated digital payments — UPI, wallets, net-banking, QR, cards. The UPI PIN in the user's own app *is the mandate*, not an obstacle to automate.

So an in-app **book + pay** flow is possible — but only by changing model, which is a genuine strategy-axis value, not a bug fix:

| Tier | Mechanism | In-app payment ceiling |
|---|---|---|
| **Reverse-engineered** (what's built: `apiReplay` / `browserListen` / `agentDrive` on the user's account) | drive the user's own session | **Handoff only — by law.** Never in-app payment. |
| **Partner API** (`partnerApi` — the 4th transport strategy) | official rails; **we are the merchant of record** | **Fully in-app: login, book, pay, track.** |
| **Agentic rails** (UAP / AP2 / ACP) | delegated mandate with a spend cap | Fully autonomous, once RBI clears it |

**Partner rails that already exist and would slot in behind the same `Outcome` contract:**

- **Delivery → Uber Guest Rides API** (Uber for Business): OAuth2 client-credentials (`guest.rides` scope), `POST` a guest trip with pickup/drop coords + product id. The guest needs **no Uber account** and **the organization's account pays**. Sandbox available. This is your P1 adapter — dispatch/track/cancel — except sanctioned, CAPTCHA-free, and *payment already runs through you*. It returns `kind: 'executed'` cleanly.
- **Grocery + Home services → ONDC buyer node**: register as a Buyer App, transact `search → select → init → confirm`, **collect payment yourself**. Both categories are live domains: grocery (`RET10`) and the **Services** domain (home services, appliance repair, beauty/personal care — the literal UC job). You don't get *Blinkit*/*Urban Company* as brands; you get the same consumer outcome from network sellers, legally.
- **Blinkit specifically → Swiggy MCP** is the only sanctioned surface (COD-only, blocks carts ≥ ₹1,000, invite-only).

**The genuinely-autonomous, lawful path today** is **UPI Autopay / e-mandate**: RBI's AFA exemption allows recurring debits **up to ₹15,000 per transaction with no per-debit AFA**, after one authenticated e-mandate registration. The user authorizes the agent once (PIN, in *our* app); after that the agent charges and books with zero taps. This maps 1:1 onto the EXECUTE gate — the gate becomes a **spend-cap check**, not a payment step.

**What's coming, and why the harness is already the right shape:** NPCI's **Unified Agent Protocol** (verified-agent registry + spend caps + explicit consent + accountability; needs RBI approval, not live), Google's **AP2** (signed Intent→Cart→Payment mandates; now under FIDO governance, v0.2 adds Human-Not-Present), and OpenAI/Stripe's **ACP** (single-use, time-bound, amount-capped SharedPaymentTokens). Every one mandates: a human-approved intent, a bounded amount, a verifiable authorization, revocability. **That is the EXECUTE gate + ₹1,000 cap + idempotency + kill path already built** — this project is protocol-shaped ahead of the protocol.

**Caveat, stated not hidden:** becoming the merchant means owning the order — GST, refunds, support, liability — and using a licensed PG (Razorpay/Stripe) so you never hold customer funds yourself, or you're into RBI Payment Aggregator licensing territory.

---

## 8. Mobile substrate — the same approach on a heavier vehicle

Several of the interesting targets have **no web surface at all** — Snabbit is app-only, Porter is app-only, Rapido's useful surface is mobile-only (DESIGN.md §7, §15.1). So the natural question is whether the unified approach survives a jump to native mobile apps. It does — and the reassuring part is that **nothing above the transport layer changes.** The `Adapter` interface, the six-step lifecycle (§2), the three strategy axes (§3), and the four-kind `Outcome` contract (§5) all hold unchanged. A mobile target is a 4th adapter that picks a *mobile value* on the transport axis.

What changes is the **substrate**. The web harness runs everything on one vehicle — "a real browser as the TLS vehicle" (`page.evaluate(fetch)`) — and picks a transport strategy *inside* it. Mobile is the **same three strategies on a different vehicle**: an instrumented device or emulator instead of a Chrome page.

| Transport strategy | Web substrate (built) | Mobile substrate (analog) |
|---|---|---|
| `apiReplay` | `page.evaluate(fetch)` capture → replay | **mitmproxy on an emulator + cert-pinning bypass** (Frida / objection) → replay the JSON |
| `browserListen` | Playwright response listener | **Frida hooks / proxy** reading the app's own responses in flight |
| `agentDrive` | Playwright-MCP + LLM on the DOM a11y tree | **mobile-mcp / Appium-MCP + LLM on the native accessibility tree** — same shape, tap/type/swipe instead of click |

That bottom row is the striking one: the 2026 mobile-agent ecosystem is a near-exact mirror of the UC drive (DESIGN.md §14.7). **mobile-mcp** and agents like **AppClaw / MobileUse** expose a native app's accessibility snapshot to an LLM over MCP — structurally identical to driving UC's DOM with Playwright-MCP behind a Mastra agent. Your `agentDrive` strategy ports with mostly a driver swap.

### Why mobile is genuinely a tier harder (the honest part)

The pattern ports; the cost and risk jump on four axes:

1. **Cert pinning is the new Cloudflare, and nastier.** Web capture "just worked" because a same-origin fetch sailed through. Mobile apps pin their TLS, so `mobileReplay` / `mobileListen` need Frida to hook the validation. The serious apps pin in **native C++/BoringSSL**, which needs memory-offset hooking — real per-app reverse-engineering, not a one-liner.
2. **Attestation can wall you out entirely.** **Play Integrity** (Android) and **DeviceCheck / App Attest** (iOS) let an app *server-side* detect a rooted device, an emulator, or a hooked process and refuse to run — not bypassable from the client. This is the mobile equivalent of UC's Turnstile, except it can gate the **whole app**, not just login. Where it's enforced hard, the reverse-engineered tier is simply closed — the same "respect the wall" judgment already made for UC.
3. **Substrate weight.** Web needs one headless Chromium per user. Mobile needs a **rooted emulator or device farm**, per-OS toolchains (Android and iOS are entirely separate rigs), rooting/jailbreak upkeep, and Frida running as a detectable process. The cheap `.data/uber-profiles/<user>` persistent-session model has no direct mobile equivalent.
4. **ToS / legal exposure is strictly higher.** Rooting + instrumenting + pinning-bypass is a far clearer anti-circumvention story than a same-origin fetch in a logged-in browser. Acceptable for a capture rig; not something to run at scale against a third party.

### "Mobile outcome" has two meanings — separate them

- **Mobile as transport** (above) — reverse-engineer app-only targets. *Common approach: yes, same strategy library; the substrate is a mobile-capture rig, and it's the heaviest/most brittle/most legally-exposed one.*
- **Mobile as the delivery / handoff surface** — the cheap, underrated win. The `Outcome` union's `handoff` kind (§5) already fits mobile natively: `handoff:link` on a phone becomes an **Android intent / iOS universal link / app-clip** that opens the target app pre-filled. This is *exactly* what the Uber Tier-A deep link (`m.uber.com/go/product-selection?…`) and the Blinkit share link already do — and on mobile those deep links are **stronger**, not weaker. A mobile-based *handoff* needs **no new capture at all** — just emit platform deep links from the same `Draft`.

### Recommended sequencing (don't build a device farm speculatively)

A mobile-capture rig is the heaviest substrate and only unlocks targets with *no web surface whatsoever*. So, respecting the project's own findings:

1. **Free win first** — make the `handoff` outcome emit mobile deep links / app intents from the existing `Draft`. Zero capture, works today, genuinely "mobile."
2. **When a target is truly app-only** (Snabbit, Porter) — reach for `mobileAgentDrive` (mobile-mcp + LLM) *before* `mobileReplay`. Driving the UI dodges cert-pinning entirely and reuses the proven UC agent-drive pattern; descend to Frida/mitm only if you specifically need the raw API.
3. **Treat Play Integrity like UC's Turnstile** — if an app hard-attests, that's the ceiling: document it and fall back to the handoff / partner tier, don't start an arms race.
4. **For app-only targets where you actually want book + pay** — the partner rails from §7 (ONDC for grocery/services, Uber Guest Rides for delivery) beat any mobile reverse-engineering: a `partnerApi` transport that needs no device farm at all.

**Bottom line for mobile:** the unified approach is *substrate-independent above the transport layer*. Mobile adds three new transport-strategy values (`mobileReplay` / `mobileListen` / `mobileAgentDrive`) on an instrumented-device vehicle, and one new ceiling (attestation) alongside the existing bot-wall and payment ceilings. The handoff tier reaches mobile for free; the capture tier is a real but heavy, last-resort substrate.

---

## 9. Bottom line

- **Unify the lifecycle and the outcome, not the flow.** Six steps and a four-kind `Outcome` union are genuinely common; the transport and the terminal move are genuinely per-target, and forcing them together would break at least one service.
- **Isolate the variation behind a small strategy library** (transport × auth × terminal). Three of each are already proven; a 4th service picks a combination instead of inventing one.
- **Make adapters self-describing + capability-declaring**, so the core stops knowing the service list and a 4th app touches one directory instead of five files.
- **Name the checkout ceiling honestly.** The reverse-engineered tier is handoff-capped by RBI law; a `partnerApi` tier (Uber Guest Rides today, ONDC for grocery/services) is the only way to do in-app *book + pay* now, and the emerging agentic rails (UAP/AP2/ACP) are the autonomous future the gate is already built for.
- **The approach is substrate-independent above the transport layer.** Mobile (app-only targets) reuses the whole design and just adds three transport values on an instrumented-device vehicle — heavier, and with attestation as an extra ceiling. The *handoff* tier reaches mobile for free via deep links / app intents; the *capture* tier is a real but last-resort substrate (§8).

### Concrete next steps this implies
1. **Land the `Outcome` union** in `core/adapter.ts`; have all three adapters return it; delete the `'dispatched'`/`'ready-to-pay'`/`checkoutUrl` special-cases from `session.ts` and `chat.tsx`. *(Contained refactor: nine strings → four kinds. Do this first — it's the change that actually makes #4 a drop-in.)*
2. **Extract the strategy library** (`core/transport/`, `core/auth/`, `core/terminal/`) from the three existing `client.ts` files.
3. **Prove the partner tier** by building an **Uber Guest Rides** adapter as a `partnerApi` transport returning `kind: 'executed'` — sandbox first, no spend — demonstrating a real end-to-end in-app book + pay + track that the reverse-engineered tier legally cannot.

---

### Sources
- RBI 2FA/AFA directions, mandatory 1 Apr 2026 — https://www.business-standard.com/finance/news/rbi-two-factor-authentication-digital-payments-guidelines-2026-125092501154_1.html
- RBI e-mandate AFA exemption (≤ ₹15,000) — https://www.medianama.com/2026/04/223-rbi-additional-factor-authentication-e-mandates/
- Uber Guest Rides API — https://developer.uber.com/docs/guest-rides/introduction · Create Guest Trip — https://developer.uber.com/docs/guest-rides/references/api/v1/guest-trips-post
- ONDC — roles / build a buyer app — https://www.ondc.org/roles-you-can-play/ · Services domain — https://www.ondc.org/services/
- NPCI Unified Agent Protocol — https://www.business-standard.com/finance/news/india-may-allow-agentic-ai-led-upi-transactions-under-new-npci-protocol-126070801343_1.html · https://www.medianama.com/2026/07/223-npci-agentic-payments-upi/
- Google AP2 — https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol · Agentic payment protocols compared (ACP/AP2/x402) — https://www.crossmint.com/learn/agentic-payments-protocols-compared
- Capability-registry / plugin patterns — OpenClaw plugin architecture (https://docs.openclaw.ai/plugins/architecture); TypeScript Type Registry pattern (https://frontendmasters.com/courses/typescript-v4/type-registry-pattern/); interface segregation for hexagonal ports (https://codeartify.substack.com/p/interface-segregation)
- Mobile agent automation — mobile-mcp (https://github.com/mobile-next/mobile-mcp); Appium MCP (https://rahulec08.github.io/appium-mcp/)
- Mobile reverse-engineering ceilings — OWASP MASTG, bypassing certificate pinning (https://mas.owasp.org/MASTG/techniques/android/MASTG-TECH-0012/); SSL pinning bypass with Frida incl. native/BoringSSL hardening (https://dev.to/deepak_mishra_35863517037/bypassing-ssl-pinning-with-frida-advanced-mobile-scraping-54cl)
