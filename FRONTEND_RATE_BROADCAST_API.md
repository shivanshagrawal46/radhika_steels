# Rate Broadcast — Frontend Integration Guide

All events listed below run over the **existing employee Socket.IO namespace
(`/`)**. They use the same JWT handshake auth as every other admin event —
no separate endpoint or token.

```js
// Connection (same as rest of admin app)
const socket = io("https://your-backend-host", {
  auth: { token: employeeJwt },
  transports: ["websocket"],
});
```

Every event uses the standard ack-callback pattern:

```js
socket.emit("event_name", payload, (response) => {
  if (response.success) { /* response.data */ }
  else { /* response.error */ }
});
```

---

## 1. Product Catalog

Fetch the 6 products the admin can choose from. These are the only keys that
may appear in any subscriber's `subscribedProducts` array.

### `broadcast_catalog:list`
**Payload:** none

**Response:**
```json
{
  "success": true,
  "data": {
    "catalog": [
      { "key": "wr_55",         "displayName": "Wire Rod 5.5mm",               "loadingCharge": 345, "category": "wr" },
      { "key": "wr_7",          "displayName": "Wire Rod 7mm",                 "loadingCharge": 345, "category": "wr" },
      { "key": "hb_10",         "displayName": "H.B Wire 10g",                 "loadingCharge": 345, "category": "hb" },
      { "key": "hb_12",         "displayName": "H.B Wire 12g",                 "loadingCharge": 345, "category": "hb" },
      { "key": "binding_20_wow","displayName": "Binding Wire 20g (without wrapper)", "loadingCharge": 515, "category": "binding" },
      { "key": "binding_20_ww", "displayName": "Binding Wire 20g (with wrapper)",    "loadingCharge": 515, "category": "binding" }
    ]
  }
}
```

Render each entry as a checkbox. The admin picks **exactly 3** or **exactly 5**
for each subscriber.

---

## 2. Subscriber Management (CRUD)

### 2.1 `rate_subscribers:list` — paginated list
**Payload (all optional):**
```json
{
  "search": "rajesh",
  "page": 1,
  "limit": 50,
  "onlyActive": false
}
```
- `search` matches phone, name, firmName, or customerId (case-insensitive regex).
- `limit` is capped server-side at 200.

**Response `data`:**
```json
{
  "items": [
    {
      "_id": "66fb...",
      "phone": "919876543210",
      "name": "Rajesh Kumar",
      "firmName": "Kumar Traders",
      "notes": "Prefers morning",
      "customerId": "RS-CUST-0112",
      "subscribedProducts": ["hb_12", "wr_55", "binding_20_wow"],
      "isActive": true,
      "statementCounter": 47,
      "lastStatementNumber": 47,
      "lastSentAt": "2026-04-17T03:45:18.211Z",
      "lastSentStatus": "sent",
      "lastSentError": "",
      "totalSent": 47,
      "totalFailed": 0,
      "addedBy": "66aa...",
      "addedByName": "Admin",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "total": 312,
  "activeCount": 298,
  "page": 1,
  "limit": 50
}
```

### 2.2 `rate_subscribers:add` — create / re-activate
**Permissions:** admin or manager role required.

**Payload:**
```json
{
  "phone": "9876543210",
  "name": "Rajesh Kumar",
  "firmName": "Kumar Traders",
  "notes": "Prefers morning",
  "subscribedProducts": ["hb_12", "wr_55", "binding_20_wow"]
}
```
- `phone` accepts any format — server normalises (strips non-digits, prepends `91` if 10 digits).
- `subscribedProducts` is REQUIRED on add. Length must be exactly **3 or 5**.
- Upserts by phone: re-adding a soft-deleted phone re-activates it.

**Response `data`:** the full subscriber document (same shape as list item).

**Broadcast event:** after success, server emits to the `employees` room:
```json
{ "action": "add", "subscriber": { /* full doc */ } }
// Channel: rate_subscribers:updated
```

### 2.3 `rate_subscribers:update` — edit existing
**Permissions:** admin or manager.

**Payload:** (pass only the fields you want to change; `id` is required)
```json
{
  "id": "66fb...",
  "name": "Rajesh K",
  "firmName": "Kumar Traders Pvt Ltd",
  "notes": "",
  "isActive": true,
  "subscribedProducts": ["hb_12", "wr_55", "wr_7", "hb_10", "binding_20_ww"]
}
```
- Validates `subscribedProducts` the same way as `add` (must be 3 or 5).
- Phone cannot be changed — delete + re-add if you need a different number.

**Response `data`:** the updated subscriber document.

**Broadcast event:**
```json
{ "action": "update", "subscriber": { /* full doc */ } }
// Channel: rate_subscribers:updated
```

### 2.4 `rate_subscribers:remove` — soft or hard delete
**Permissions:** admin or manager.

**Payload:**
```json
{ "id": "66fb...", "hard": false }
```
- `hard: false` (default) → sets `isActive: false`, preserves history.
- `hard: true` → permanent delete from DB.

**Response `data`:** `{ "removed": true, "hard": false, "phone": "919876543210" }`

**Broadcast event:**
```json
{ "action": "remove", "id": "66fb...", "hard": false }
// Channel: rate_subscribers:updated
```

### 2.5 `rate_subscribers:preview` — dry-run a message
Renders the exact template params and the rendered body for ONE subscriber
WITHOUT sending anything or incrementing counters. Use this for the admin's
"Preview message" button.

**Payload:** `{ "id": "66fb..." }`

**Response `data`:**
```json
{
  "templateName": "rate_statement_3p",
  "language": "en",
  "params": [
    "Rajesh", "48", "RS-CUST-0112",
    "Daily Morning Notification",
    "17 Apr 2026, 09:15 AM", "47",
    "H.B Wire 12g: 50,111 + 345 + 18%",
    "Wire Rod 5.5mm: 52,300 + 345 + 18%",
    "Binding Wire 20g (without wrapper): 58,256 + 515 + 18%"
  ],
  "renderedMessage": "Namaste Rajesh, your rate statement #48 is ready...\n\nCustomer ID: RS-CUST-0112\nStatement: Daily Morning Notification\n...",
  "snapshotErrors": {}
}
```
- `snapshotErrors` is an object of `{ productKey: errorMessage }` for any
  catalog products whose rates could not be computed (e.g. admin hasn't set
  the WR base rate yet). If the subscriber selected one of those products,
  the actual send will fail too — warn the admin in the preview UI.

---

## 3. Audience Previews (button counters)

### 3.1 `rate_update:preview_all`
**Payload:** none

**Response `data`:**
```json
{ "count": 298 }
```

### 3.2 `rate_update:preview_24h`
Returns everyone who has sent us a WA message in the last 24 hours. These
are the "free window" recipients — they get the all-6-rates plain-text
message when the admin triggers the 24h broadcast.

**Payload:** none

**Response `data`:**
```json
{
  "count": 34,
  "users": [
    {
      "phone": "919812345678",
      "waId": "919812345678",
      "name": "WhatsApp Profile Name",
      "partyName": "...",
      "contactName": "...",
      "firmName": "...",
      "lastIncomingAt": "2026-04-17T08:12:44.000Z"
    }
  ]
}
```

---

## 4. Broadcasts

Only ONE broadcast can run at a time server-wide. The second attempt is
rejected immediately with `"error": "Another broadcast is already running"`.

Permission: admin or manager role required.

### 4.1 `rate_update:send_to_all`
Sends the approved Utility template to every active subscriber, using the
products each subscriber has picked. Morning / Afternoon / Evening label is
auto-picked from the current IST time.

**Payload:** none

**Immediate ack:**
```json
{
  "success": true,
  "data": { "started": true, "audience": "all_subscribers", "startedAt": "2026-04-17T03:45:00.100Z" }
}
```

After this, listen on the broadcast events below for progress and
completion (fired to the `employees` room).

### 4.2 `rate_update:send_to_24h_replied`
Sends ALL SIX catalog rates as a single plain-text WhatsApp message (NOT a
template — free inside the 24h service window) to every user detected by
`preview_24h`.

**Payload:** none

**Immediate ack:**
```json
{
  "success": true,
  "data": { "started": true, "audience": "24h_replied", "startedAt": "..." }
}
```

---

## 5. Live Broadcast Events

Subscribe to these once on app load — server fans them out to every employee
socket so any open admin window sees the same progress.

### 5.1 `rate_update:started`
```json
{
  "audience": "all_subscribers",   // or "24h_replied"
  "startedBy": "Shivansh",
  "startedAt": "2026-04-17T03:45:00.100Z"
}
```

### 5.2 `rate_update:progress`
Fires once per recipient attempt.
```json
{
  "audience": "all_subscribers",
  "index": 12,
  "total": 298,
  "phone": "919876543210",
  "status": "sent",                  // or "failed"
  "statementNumber": 48,             // only on success for Utility broadcast
  "error": "..."                     // only on failure
}
```

### 5.3 `rate_update:done`
Fires once at the end.
```json
{
  "audience": "all_subscribers",
  "startedBy": "Shivansh",
  "startedAt": "...",
  "finishedAt": "2026-04-17T03:47:12.880Z",
  "sent": 295,
  "failed": 3,
  "total": 298,
  "errors": [
    { "phone": "919...", "error": "(#131026) Message undeliverable", "code": 131026, "subcode": null }
  ],
  "snapshotErrors": {}               // productKey -> message for any product whose rate couldn't be computed
}
```
If the entire runner throws, `done` is still fired — with additional
`"error": "<top-level reason>"` and `sent/failed/total = 0`.

### 5.4 `rate_subscribers:updated`
Fires on add / update / remove so multi-admin sessions stay in sync.
```json
{ "action": "add",    "subscriber": { /* full doc */ } }
{ "action": "update", "subscriber": { /* full doc */ } }
{ "action": "remove", "id": "66fb...", "hard": false }
```

---

## 6. Suggested UI Flow

### "All Subscribers" screen
1. On mount → `broadcast_catalog:list` (cache the 6 products for the whole session).
2. `rate_subscribers:list` with pagination + search.
3. Row actions → edit / remove / preview.
4. "Add subscriber" button → phone + name + firmName + notes + product picker (enforce exactly 3 or exactly 5 checked).
5. Header buttons:
   - **Send to All Subscribers** → confirm dialog → `rate_update:send_to_all`. Show the count from `rate_update:preview_all` inside the button.
   - **Send to 24h-Replied Users** → confirm dialog → `rate_update:send_to_24h_replied`. Show count from `rate_update:preview_24h`.

### Broadcast in progress
1. On `rate_update:started` → open a progress modal with spinner and "0 / N sent".
2. On each `rate_update:progress` → update progress bar; optionally show a live log line.
3. On `rate_update:done` → swap modal to summary with sent / failed / error list; offer a "Download failures CSV" button client-side.

### Per-subscriber preview
1. On row → "Preview" button → `rate_subscribers:preview` → show the `renderedMessage` in a phone-shaped mock so the admin sees exactly what the user will get.
2. If `snapshotErrors` is non-empty → show a warning banner explaining which product(s) have no rate configured.

---

## 7. Errors & Edge Cases Worth Handling In UI

| Scenario | Where it shows up | Recommended UX |
|----------|-------------------|----------------|
| Admin picks 0, 1, 2, 4, or 6+ products | `rate_subscribers:add/update` returns `"error": "subscribedProducts must be exactly 3 or exactly 5 items"` | Disable Save button until 3 or 5 are checked. |
| Duplicate phone add | Server upserts, but name/products are overwritten | Warn "This phone already exists — saving will overwrite its products. Continue?" |
| Admin hasn't set the WR base rate | Preview/send populates `snapshotErrors: { wr_55: "..." }` | Red banner "Rates not configured — set base rates before broadcasting." |
| Concurrent broadcast attempt | Send event returns `"Another broadcast is already running"` | Disable the Send button while any `rate_update:started` has no matching `done` yet. |
| Subscriber deleted during send | Per-recipient `progress` event carries `status: "failed", error: "Subscriber disappeared before send"` | Show in final error list; no manual action needed. |
| 24h window empty | `count: 0`, `users: []` | Disable the "Send to 24h" button. |

---

## 8. Data Shapes — Quick Reference

### Subscriber
```ts
interface RateSubscriber {
  _id: string;
  phone: string;                      // E.164-ish, e.g. "919876543210"
  name: string;
  firmName: string;
  notes: string;
  customerId: string;                 // "RS-CUST-0112" — permanent once assigned
  subscribedProducts: string[];       // length exactly 3 or exactly 5
  isActive: boolean;
  statementCounter: number;           // monotonic per-user
  lastStatementNumber: number;
  lastSentAt: string | null;          // ISO
  lastSentStatus: "sent" | "failed" | null;
  lastSentError: string;
  totalSent: number;
  totalFailed: number;
  addedBy: string | null;             // Employee ObjectId
  addedByName: string;
  createdAt: string;
  updatedAt: string;
}
```

### Catalog entry
```ts
interface CatalogProduct {
  key: string;              // "hb_12", "wr_55", ...
  displayName: string;      // "H.B Wire 12g"
  loadingCharge: number;    // Rs/MT
  category: "wr" | "hb" | "binding";
}
```

### Broadcast summary
```ts
interface BroadcastSummary {
  sent: number;
  failed: number;
  total: number;
  errors: Array<{ phone: string; error: string; code?: number; subcode?: number }>;
  snapshotErrors: Record<string, string>;   // productKey -> message
}
```
