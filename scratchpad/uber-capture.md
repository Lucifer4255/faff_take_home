# Uber web adapter — captured API contract (11 Jul 2026, via Claude-in-Chrome, guest/no-login)

Host: `www.uber.com` (same-origin JSON RPC). All calls: `POST /api/<handler>`, `content-type: application/json`,
header `x-csrf-token: x` (same-origin, static), `credentials: include`. Behind Cloudflare (`__cf_bm`) but the
in-browser `fetch` (page origin) sails through — this is the Blinkit/UC "browser as TLS vehicle" pattern.
404 body `{"status":"failure","data":{"message":"Missing RPC handler for X","code":"ERR_MISSING_HANDLER"}}` = wrong handler name.

## TIER A — guest, NO login. VERIFIED working end-to-end.

### 1. resolve step (autocomplete)  — `POST /api/pudoLocationSearch`
req:  `{ latitude, longitude, query, type: "PICKUP"|"DROPOFF" }`  (lat/lng = city bias center)
resp: `{ status:"success", data: { "0":[ {addressLine1, addressLine2, categories[], confidence, id, provider:"google_places", source:"SEARCH", type:"LOCATION"}, ... ] } }`
NOTE: results carry google-place `id` but **no coordinates** → need step 2.

### 2. resolve step (place → coords)  — `POST /api/getPlaceDetails`
req:  `{ id, provider:"google_places", type:"PICKUP"|"DROPOFF" }`
resp: `{ status:"success", data: { addressLine1, addressLine2, fullAddress, id, lat, long, provider, title, categories[], addressComponents:{CITY,COUNTRY_CODE,FIRST_LEVEL_SUBDIVISION_CODE,HOUSE_NUMBER,POSTAL_CODE,STREET_NAME} } }`

### 3. booking-ready handoff  — construct deep link (the Tier-A deliverable, analogous to Blinkit cart link)
`https://m.uber.com/go/product-selection?pickup=<enc>&drop[0]=<enc>[&vehicle=<id>]`
where each `<enc>` = `encodeURIComponent(JSON.stringify(node))`, node =
`{ addressLine1, addressLine2, fullAddress, id, source:"SEARCH", latitude:lat, longitude:long, provider, title }`
Opens Uber's ride app pre-filled with pickup+drop (+ optional vehicle). Human logs in → sees fares → confirms.
VERIFIED: Park St → Quest Mall built a valid 1193-char link; the UI's own "See prices" produced this exact URL shape.

## TIER B — logged in. CAPTURED 11 Jul (Claude-in-Chrome, logged in as user; book was BLOCKED at network layer, nothing dispatched/charged).
Host: `m.uber.com` — single GraphQL endpoint `POST m.uber.com/go/graphql` (operationName-keyed; app uses XHR, some fetch).
Reached by opening the Tier-A deep link `m.uber.com/go/product-selection?pickup=&drop[0]=&vehicle=<VVID>` in the logged-in browser.
Ops observed (operationName): PudoLocationSearch, PudoLocationRefinement, PudoResolveLocationPudoFragment (resolve, in-app),
`Products` (QUOTE), `GetStatus` (polled — TRACKING), `GetPrePlusOnesData`, `TripRequest` (BOOK/confirm — money line).

### request_quote  — op `Products`
resp: `data.products.{ defaultVVID, productsUnavailableMessage, tiers:[ { products:[ {
  displayName, description, detailedDescription, cityID, currencyCode:"INR", capacity,
  estimatedTripTime(sec), etaInMin, fares:[ { capacity, fare:"₹104.99", fareAmountE5:10499000 (=fare*1e5), hasPromo, meta:"<json fare token>" } ] } ] } ] }`
Live sample Park St→Quest Mall: Uber Go AC ₹104.99, Bike ₹33.50, Go Non AC ₹81.22/₹76.99, Premier AC ₹127.99. VVID e.g. 2022=Uber Go AC, 20030581=Go Non AC.

### confirm / book  — op `TripRequest` (mutation) — EXECUTE GATE, real money
variable fields (from blocked capture, top-level): attribution{sourceURL,utmParameters}, capacity,
pickupLocation + destinations:[ { addressLine1, addressLine2, coordinate:{latitude,longitude}, id, provider, source, locationSource } ],
guest, meta (the fare token from Products.fares[].meta), + (truncated) payment profile + product/VVID + fareEstimate ids.
CAPTURE METHOD (reuse in adapter's own Playwright): monkey-patch fetch+XHR to record body and BLOCK all `/go/graphql`, verify block with a test request, THEN click Request → TripRequest captured, never sent.

### observe / tracking  — op `GetStatus` (polled repeatedly)  → active trip/session status.

Login = human step (Google OAuth or OTP), never automated. Session device/IP-bound → adapter drives the user's own logged-in Playwright profile (persist storageState, gitignored) — the "linked account", like Blinkit B4 / UC Tier B. Cloudflare + same-origin CSRF (`x-csrf-token:x`) satisfied inside the browser.

## Adapter mapping (src/adapters/delivery)
- resolve_location  -> pudoLocationSearch + getPlaceDetails  (Tier A, done)
- request_quote     -> booking-ready deep link now (Tier A) / real fare endpoint after login (Tier B)
- confirm           -> create-trip (Tier B, gated)
- observe           -> trip-status poll (Tier B)
Geocode: Uber's own pudoLocationSearch replaces Nominatim for this adapter (Google-Places backed, matches Uber's ids).
