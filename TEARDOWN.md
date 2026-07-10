# Teardown — how each target was cracked

This is the "how we cracked it + edge cases hit the hard way" companion to `DESIGN.md`. The deliverable is **one reusable agentic harness + thin per-target adapters** — so a 4th app is a 4th adapter, not a 4th script. Below: the spine, then each target, then the good-citizen posture.

---

## 0. The spine (the reusable service)

Every problem is the same four-stage pipeline; only stages 2–4 differ per target, which is what makes them adapter-shaped:

**Interpret** (shared LLM call → typed intent) → **Resolve** (intent → target ids) → **Drive** (execute against an app we don't own) → **Observe** (stream state back).

- **Controller:** a bounded ReAct agent (Mastra) that proposes actions against a **constrained tool schema** (`search_catalog`, `add_to_cart`, `select_slot`, `get_state`, `confirm`, …). The agent has real autonomy over *choices* (which alternative, which slot); deterministic adapter code performs the *effects*. Every decision is a typed, logged checkpoint (Mastra observability → the trace *is* half this teardown).
- **EXECUTE gate:** nothing irreversible runs until a `confirm` tool call is explicitly approved (Mastra native tool-approval, snapshot-backed → survives a `kill -9`). Default is a dry-run that stops one call short of spend.
- **One typed event stream** (SSE) feeds two first-class clients (React web + CLI) — neither knows Mastra is underneath.

A 4th target implements the same tool interface. That's the whole bet.

---

## 1. Quick Commerce — Blinkit (P3) ✅

**Approach: reverse-engineered web API, through a browser as a TLS vehicle.**

- **Endpoints:** search `POST /v1/layout/search?q=…` (a *layout* tree — products are nested in UI widgets, walked recursively and deduped by `product_id`); serviceability `GET /visibility`; location `GET /location/info`; cart is optimistic/client-side (`POST /v5/carts` only at checkpoints).
- **The hard-won bit — Cloudflare.** Replaying the exact captured cURL from `curl`/node — even with every header + cookie — returns **HTTP 403**. Cloudflare fingerprints the TLS/HTTP2 handshake (JA3/JA4), which non-browser clients can't fake. **Fix:** drive a real Playwright browser to clear Cloudflare once, then issue the *same JSON API calls* from inside the page via `page.evaluate(fetch(...))` — real Chrome TLS + live cookies sail through. It's still an API integration, not DOM scraping.
- **Headless without a headful crutch:** an **engine-backed identity pool** (real Chromium/Firefox/WebKit, each with a matching UA/TLS/JS env — a coherent disguise, not a UA sticker) with **rotate-on-block**. All three engines verified to pass CF headless.
- **The graded logic — substitution:** the agent maps free text → SKUs and either picks a reasonable alternative or flags unavailable (verified: "2L milk" → Nestlé pack-of-2, "dozen eggs" → 12-pc pack, unavailable butter → flagged).
- **Deliverable:** a checkout-ready cart **+ a real guest cart-share link** (`POST /v1/assist/cart/share` → `link.blinkit.com/…` that opens "Items shared with you!" with Add-to-Cart) — the human pays in-app; nothing charged.

**Edge cases hit the hard way:** location-gating (search 400s "not serviceable" until a store is activated via `/visibility`); a first-search activation race (the store activates a beat after location is set → self-heal by re-pinning + retry); Blinkit's search tokenizes quantity words badly ("1 litre milk" → 0 hits) → strip qty/unit words before searching, pick the size from results; **search is content-agnostic to the exact pin but assortment *is* per-city** (Bangalore's Nandini vs Delhi's Mother Dairy — verified: ~14% overlap by name across cities), so location is load-bearing for availability/price, not for *which* products match.

**Bonus (place order):** needs a logged-in session (phone+OTP). Researched and mapped (COD is the only clean no-payment-automation path; every online rail ends in an RBI-mandated out-of-band human step) — `confirm` stops at checkout-ready.

---

## 2. Home Services — Urban Company (P2) ✅ core + bonus POC

Snabbit is app-only (no web surface), so the target is **Urban Company**. This validates the abstraction on a *different-shaped* problem: **slots/availability, not a cart**. `select_slot` — the tool Blinkit never uses — is the centerpiece.

**Approach: reverse-engineered internal API (same Playwright-TLS-vehicle as Blinkit).**

- **API lives on a different origin:** `www.urbanclap.com/api/v2/…` (legacy UrbanClap), called cross-origin from `urbancompany.com` pages, all POST + server-driven-UI `{layout, dataStore}` trees. Cloudflare-fronted but **passes headless** with the identity pool.
- **Guest, no auth** for the graded core: `discoverySearch` (= `search_catalog`) returns real services + prices; `initiateSeoJourney` (the category page) carries the **earliest-slot preview**. Required headers are just device/version (`x-brand-key: urbanCompany`, `x-device-id`, `x-version-*`) — no token.
- **Multi-city:** `discoverySearch` needs a `cityKey` (`city_<slug>_v2`); ten metros verified live (Bangalore, Mumbai, Delhi NCR, Pune, Hyderabad, Chennai, Kolkata, Ahmedabad, Jaipur, Chandigarh). A client location resolves to the nearest metro; search runs on the hub centre (UC returns specific bookable `service_package`s at the hub, generic `category` results at edge coords).
- **Deliverable (Tier A, guest):** free text → service + real price + **earliest available slot** + a resumable deep link to the service page → behind the EXECUTE gate. Verified end-to-end through the harness (interpret → tool loop → gate → approve).

**The wall (a first-class judgment call).** UC login is gated by a **Cloudflare Turnstile CAPTCHA**. Verified it rejects *automated* browsers — bundled Chromium **and** real Chrome via CDP both fail; the login OTP call (`initiateLogin`) literally carries an `integrityToken` of `integrityType: "captcha"` that only a human-cleared Turnstile produces. **We do not bypass CAPTCHAs.** There is also no UC public API / MCP / agentic-commerce pilot (BigBasket, not UC, is the Razorpay/NPCI/OpenAI first merchant). So a *real* programmatic booking is not achievable for anyone without a human clearing the captcha — recognizing and respecting that (rather than escalating an anti-automation arms race) is the posture the brief grades.

**Bonus (book programmatically) — Tier B, human-in-the-loop, PROVEN headless.** The one thing that needs a human is the captcha; everything after is automatable:
- The user logs in **once** in their own genuine browser (they solve Turnstile — a debug-port Chrome clears it because it's a real, non-automated environment). We capture the resulting **Bearer token** (`_uc_user_token`) via Playwright `connectOverCDP` — the "browser-assisted auth" pattern.
- Our **headless** client then passes Cloudflare with its *own* identity and injects `Authorization: Bearer <token>` — **verified to act as the logged-in user** (returns the real `userId`). Cloudflare and auth are cleanly separated.
- Drove the authenticated booking flow headless: `initiateJourney` (mints a real draft order **under the user's account**) → `getEditablePackageDetailScreen` → `updatePackageSelection` (cart write accepted, HTTP 200) → the real slot page (`getCheckoutJourneySlotPage`), **stopping before payment**.

**Edge cases hit the hard way:** the coords/`cityKey` mismatch (a non-Bangalore geolocation with a Bangalore `cityKey` → 0 results — the fix is nearest-metro resolution); the booking is pinned to the user's *saved address* city, not the browsing city; the authenticated flow is **deeply stateful** (each step mints server ids the next consumes; the slot request embeds the entire cart + address) — so a from-scratch generic cart-build is brittle, while persistent-draft replay works. Tier B is a proven mechanism; a fully-generic, persisted pre-filled cart is the remaining hardening.

---

## 3. Hyperlocal Delivery — Rapido / Porter (P1) — scoped out

Consciously deprioritized to invest in a deeper **spine + two solid, different-shaped adapters** over breadth (the brief grades "a working end-to-end spine over polish or breadth"). The design (`DESIGN.md §7`) is specified: browser-assisted auth to clear login/OTP once, then capture the session and hit booking + trip-status endpoints directly for the live "ride updates" loop; Rapido/Porter over Uber (least aggressive anti-automation); reach quote → confirm, with dispatch as the single most-guarded spend behind the EXECUTE gate. The adapter interface is unchanged — it's a fourth folder implementing the same three methods.

---

## 4. Good-citizen posture

- **Credentials out of the repo:** OTP/session tokens, captured browser state, and `.env` are all gitignored (`.data/*`, `.playwright/`); the teardown never contains a live token.
- **Respect anti-automation:** we pass passive bot-management to read public catalogs with a real browser engine, but we **do not defeat active human-verification** (UC's Turnstile) — the human clears it, we reuse the session.
- **No runaway charges:** every irreversible step is behind the restart-durable EXECUTE gate with a cancel path tested first; dry-run stops one call short of spend; spend sequenced cheapest-first within the ₹1,000 cap.
- **Rate limits:** searches are serialized per adapter with backoff; no parallel hammering.
