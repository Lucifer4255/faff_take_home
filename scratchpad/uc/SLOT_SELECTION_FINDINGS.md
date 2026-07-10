# UC authenticated booking — the MISSING slot-selection step (captured live 2026-07-10)

Captured end-to-end via browser sweep (logged in as the real user, Kolkata,
"Furnished apartment - Home deep cleaning" 1BHK). The headless chain in
`booking.ts` stopped at `getCheckoutJourneySlotPage` (listed slots as text).
The real flow needs ONE more call: **`updateSlot`**, then the draft sits at
"Proceed to pay" — exactly the "user just pays" end state.

## Full authenticated post-login sequence (from the sweep)

```
initiateJourney                         → draftOrderId, groupId1 (layout.id)
getEditablePackageDetailScreen          → customization steps  (needs packageData echo — already fixed)
updatePackageSelection                  → cart built (ALL 3 mandatory variants, see below)
getNextGroup                            → groupId2 (= "next"/checkout group id)   ← used by updateSlot
reverseGeoCode / getUserAddress
proceedWithAddress                      → addressId
checkPackageUpdatesAtNewLocation
updateAddressInDraftOrder               → slot-page request template
getCheckoutJourneySlotPage              → slot grid (each slot = full object, see below)
logSlotPageOpenedDetails
updateSlot                              ← *** THE MISSING CALL ***  → draft ready to pay
```

## KEY FINDING 1 — cart add needs ALL mandatory customization steps

The web "Done" button stays disabled until size + kitchen-cabinets + sofa&mattress
are ALL chosen (three mandatory single-selects; their base option is ₹0).
`updatePackageSelection` req.packages[0].variants had **3** entries:
- size (e.g. "1 bhk")
- kitchen ("Cabinet exterior & stove", ₹0 base)
- sofa&mattress ("Dry vacuuming", ₹0 base)

Our `resolvePackageSelection` iterates `customizationSteps` and picks the first
option of each `isMandatory` step — so it must correctly see all three as
mandatory. Verify booking.ts picks all three, not just size.

## KEY FINDING 2 — updateSlot payload (the new call)

`POST growth/customerJourney/updateSlot`
```jsonc
{
  "city_key": null,
  "draftOrderId": "<draftOrderId>",
  "groupId": "<groupId2 from getNextGroup>",
  "categoryWiseBookingDetails": [{
    "categoryKey": "professional_home_cleaning",
    "slotDetails": {
      "bookingStartTime": "2026-07-11T02:30:00.000Z",  // slot.bookingTime (UTC; 08:00 IST = 02:30Z)
      "bookingEndTime":   "2026-07-11T02:30:00.000Z",  // slot.bookingEndTime
      "bookingTimeStrategy": "fixed",                   // slot.bookingTimeStrategy
      "hubId": "<slot.hubId>",
      "filterStrategy": "general",                      // slot.filterStrategy
      "preferredProvider": {                            // from the slot's own provider fields:
        "id":   "uc_assist",                            //   slot.providerId
        "name": "Urban Company Auto-Assign",            //   slot.providerName
        "profilePhoto": { /* slot.providerProfilePhotoLink */ }
      }
    }
  }]
}
```

## KEY FINDING 3 — each slot object in getCheckoutJourneySlotPage response

Every bookable slot in the grid is a full object (found by walking the response
for objects with both `bookingTime` and `slotId`):
```jsonc
{
  "providerId": "uc_assist",
  "providerName": "Urban Company Auto-Assign",
  "providerProfilePhotoLink": { ... },
  "dateId": "2026-07-11",
  "slotId": "08:00",
  "slotGroupId": "2026-07-11",
  "bookingTimeString": "Sat, Jul 11 at 08:00 AM",   // human label
  "bookingTime": "2026-07-11T02:30:00.000Z",         // → bookingStartTime
  "bookingEndTime": "2026-07-11T02:30:00.000Z",
  "bookingTimeStrategy": "fixed",
  "isBufferSlot": false,
  "isPreferredSlot": false,
  "filterStrategy": "general",
  "availableProviderIds": [ ... ],
  "hubId": "<24-char id>",
  "slotStartTime": "2026-07-11T02:30:00.000Z"
}
```
=> Everything updateSlot needs is inside a single slot object + groupId2 + draftOrderId + categoryKey.
Pick the earliest slot (or first with a desired dayText) and build updateSlot from it.

## Implementation plan for booking.ts
1. Replace the text-heuristic `extractSlots` with a real parser that returns slot
   OBJECTS (bookingTime, bookingEndTime, bookingTimeStrategy, hubId, filterStrategy,
   providerId/Name/ProfilePhoto, bookingTimeString for display).
2. After getCheckoutJourneySlotPage, pick the earliest slot, then POST updateSlot
   built from that slot + groupId2 + draftOrderId + categoryKey.
3. Return the chosen slot label + the fact that the draft is now payment-ready.
4. STILL stop before payment (no getCheckoutJourneyPaymentPage / pay call).
5. Note: money — advance ₹761 of ₹3,807 shown at pay step; we never cross it.
