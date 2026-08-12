# Radhika Steels Backend — Complete Documentation

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Tech Stack](#tech-stack)
4. [Environment Setup](#environment-setup)
5. [Database Models](#database-models)
6. [AI System (Intent Parser + GPT RAG)](#ai-system)
7. [Pricing Engine](#pricing-engine)
8. [WhatsApp Integration](#whatsapp-integration)
9. [Chat System](#chat-system)
10. [Employee Handoff System](#employee-handoff-system)
11. [Order Management (ERP)](#order-management)
12. [Client App (Flutter) Backend](#client-app-backend)
13. [Contact Management](#contact-management)
14. [Push Notifications (FCM)](#push-notifications)
15. [Socket.IO Events Reference](#socketio-events-reference)
16. [Deployment](#deployment)

---

## 1. Overview <a name="overview"></a>

Radhika Steels Backend is a **WhatsApp AI automation + ERP system** for a steel trading company in Raipur, Chhattisgarh. It combines:

- **AI-powered WhatsApp bot** that handles price inquiries, order confirmations, and basic conversations in Hindi/Hinglish/English
- **Real-time admin dashboard** (via Socket.IO) for employees to monitor chats, manage orders, track payments, and handle deliveries
- **Flutter client app backend** with Firebase OTP auth, admin approval workflow, real-time price updates, and FCM push notifications
- **Full ERP** tracking orders from inquiry → quote → advance → dispatch → delivery → close

### Key Design Principles

- **Socket.IO first** — All admin/client APIs use WebSockets for real-time updates. Only the WhatsApp webhook uses HTTP.
- **Layered AI** — Free regex parser handles clear requests (0.95 confidence); GPT only used for ambiguous cases → cost efficient
- **DB-first order creation** — Order is saved to database before confirmation is sent to customer
- **12-hour auto-reset** — Employee chat takeover automatically expires after 12 hours
- **Display name priority** — Party Name > Firm Name > Imported Contact > WhatsApp Name > Phone Number

---

## 2. Architecture <a name="architecture"></a>

```
┌──────────────┐     HTTP POST     ┌──────────────────────┐
│  WhatsApp    │ ──────────────── │  /webhook endpoint   │
│  Cloud API   │                   │  (webhookController) │
└──────────────┘                   └──────────┬───────────┘
                                              │
                                              ▼
                                   ┌──────────────────────┐
                                   │    chatService.js     │
                                   │  (Layered AI Engine)  │
                                   │                       │
                                   │  L1: intentParser     │
                                   │  L2: responseBuilder  │
                                   │  L2b: DB delivery     │
                                   │  L3: GPT classify     │
                                   │  L3b: GPT converse    │
                                   └──────────┬───────────┘
                                              │
                          ┌───────────────────┼───────────────────┐
                          ▼                   ▼                   ▼
                   ┌─────────────┐   ┌──────────────┐   ┌──────────────┐
                   │  MongoDB    │   │  OpenAI API  │   │  WhatsApp    │
                   │  (Models)   │   │  (GPT-4o)    │   │  Cloud API   │
                   └─────────────┘   └──────────────┘   └──────────────┘
                          ▲
                          │
┌──────────────┐  Socket.IO   ┌──────────────────────┐
│  Admin App   │ ────────── │  Socket Handlers      │
│  (Flutter)   │             │  chat, order, price,  │
└──────────────┘             │  contact, client,     │
                             │  product, approval    │
┌──────────────┐  Socket.IO  └──────────────────────┘
│  Client App  │ ──────────      /client namespace
│  (Flutter)   │
└──────────────┘
```

---

## 3. Tech Stack <a name="tech-stack"></a>

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js |
| Framework | Express.js |
| Database | MongoDB + Mongoose |
| Real-time | Socket.IO (2 namespaces) |
| AI | OpenAI GPT-4o / GPT-4o-mini |
| Messaging | WhatsApp Cloud API |
| Auth (Employees) | JWT (bcryptjs + jsonwebtoken) |
| Auth (Clients) | Firebase Phone Auth (OTP) |
| Push Notifications | Firebase Cloud Messaging (FCM) |
| Process Manager | PM2 |
| Reverse Proxy | Nginx |
| Logging | Winston |

---

## 4. Environment Setup <a name="environment-setup"></a>

### Required Environment Variables (.env)

```
NODE_ENV=production
PORT=3200

# MongoDB
MONGODB_URI=mongodb+srv://...

# JWT
JWT_SECRET=your-jwt-secret

# OpenAI
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o-mini

# WhatsApp Cloud API
WA_ACCESS_TOKEN=your-permanent-system-user-token
WA_PHONE_NUMBER_ID=1078242918702262
WA_VERIFY_TOKEN=your-webhook-verify-token
WA_API_VERSION=v21.0

# Firebase
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
# OR individual vars:
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...
```

### Setup Commands

```bash
npm install
npm run seed        # Seeds base rate with default premiums
npm run dev         # Development (nodemon)
npm start           # Production
```

### PM2 Deployment

```bash
pm2 start ecosystem.config.js
pm2 restart radhika-steel --update-env
pm2 logs radhika-steel --lines 50
```

---

## 5. Database Models <a name="database-models"></a>

### User
Stores WhatsApp users who message the business.

| Field | Type | Description |
|-------|------|-------------|
| waId | String (unique) | WhatsApp ID (phone number) |
| phone | String | Phone number |
| name | String | WhatsApp profile name |
| contactName | String | Manually assigned contact name |
| partyName | String | Business party name (permanent) |
| firmName | String | Firm/company name (permanent) |
| billName | String | Billing name (permanent) |
| gstNo | String | GST number (permanent) |
| company | String | Company name |
| city | String | City |
| isBlocked | Boolean | Block user from AI |
| lastMessageAt | Date | Last activity timestamp |

### Conversation
Tracks each active chat thread with a user.

| Field | Type | Description |
|-------|------|-------------|
| user | ObjectId → User | Linked user |
| status | enum | active / closed / escalated |
| handlerType | enum | ai / employee |
| employeeTakenAt | Date | When employee took over (12hr TTL) |
| stage | enum | Pipeline stage (talking → closed) |
| linkedOrder | ObjectId → Order | Active order for this conversation |
| context.lastDetectedProduct | Object | Last product discussed (category, size, gauge, mm, carbonType, qty) |
| unreadCount | Number | Unread messages for admin |
| lastMessage | Object | Preview of last message |

**Pipeline Stages:** talking → price_inquiry → negotiation → order_confirmed → advance_pending → advance_received → payment_complete → dispatched → delivered → closed

### Message
Individual chat messages (user, AI, employee, system).

| Field | Type | Description |
|-------|------|-------------|
| conversation | ObjectId | Parent conversation |
| sender.type | enum | user / ai / employee / system |
| sender.employeeId | ObjectId | If employee sent |
| content.text | String | Message text |
| content.mediaType | enum | none / image / document / audio / video / sticker / location |
| replyTo | ObjectId → Message | Reply-to reference |
| waMessageId | String | WhatsApp message ID |
| deliveryStatus | enum | pending / sent / delivered / read / failed |
| aiMetadata | Object | Model used, tokens, response time, intent |

### Order
Full order lifecycle tracking.

| Field | Type | Description |
|-------|------|-------------|
| orderNumber | String (unique) | Auto-generated (RS-XXXXX-XXXX) |
| user | ObjectId → User | Customer |
| conversation | ObjectId | Source conversation |
| items[] | Array | Order line items |
| items[].category | enum | wr / hb / binding / nails |
| items[].size | String | WR size (mm) |
| items[].gauge | String | HB gauge |
| items[].mm | String | HB mm specification |
| items[].carbonType | enum | normal / lc |
| items[].quantity | Number | Tons ordered |
| items[].unitPrice | Number | Price per ton |
| items[].totalPrice | Number | quantity × unitPrice |
| pricing.grandTotal | Number | Sum of all items |
| status | enum | inquiry → quoted → advance_pending → advance_received → confirmed → processing → dispatched → delivered → cancelled |
| advancePayment | Object | amount, isPaid, paidAt |
| payments[] | Array | Payment records |
| delivery.driverName | String | Driver name |
| delivery.driverPhone | String | Driver phone |
| delivery.vehicleNumber | String | Vehicle number |
| delivery.scheduledDate | Date | Expected delivery date |
| delivery.dispatchedAt | Date | Actual dispatch timestamp |
| delivery.deliveredAt | Date | Actual delivery timestamp |
| closedAt | Date | When order was closed |
| assignedTo | ObjectId → Employee | Handling employee |

### BaseRate
Admin-configurable pricing base with premiums.

| Field | Type | Description |
|-------|------|-------------|
| wrBaseRate | Number | WR 5.5mm base rate (₹/ton, ex-GST) |
| sizePremiums | Mixed | { "5.5": 0, "7": 800, "8": 800, "10": 800, "12": 1200, "14": 1500, "16": 1700, "18": 2200 } |
| carbonExtras | Mixed | { "normal": 0, "lc": 800 } |
| hbPremium | Number | 2500 (HB base = WR base + this) |
| hbGaugePremiums | Mixed | Gauge-specific premiums (6g-12g: 0, 13g: 1000, 14g: 1700, etc.) |
| fixedCharge | Number | 345 (added to every rate) |
| gstPercent | Number | 18 |
| isActive | Boolean | Only one active rate at a time |

### Contact
Employee-imported phone contacts for name resolution.

| Field | Type | Description |
|-------|------|-------------|
| phone | String | Phone number (normalized) |
| contactName | String | Contact name from phone |
| syncedBy | ObjectId → Employee | Which employee synced this |

### Client
Flutter app users (customer-facing app).

| Field | Type | Description |
|-------|------|-------------|
| firebaseUid | String (unique) | Firebase auth UID |
| phone | String (unique) | Phone number |
| name, firmName, email, gstNumber | String | Profile details |
| approvalStatus | enum | pending / approved / rejected |
| fcmTokens[] | Array | FCM push notification tokens |
| isBlocked | Boolean | Access control |

### Employee
Admin/sales staff with JWT auth.

| Field | Type | Description |
|-------|------|-------------|
| name, email, password | String | Credentials (password hashed) |
| role | enum | admin / manager / sales / support |
| isActive | Boolean | Account status |

---

## 6. AI System <a name="ai-system"></a>

### Layered Architecture

The AI processes every incoming WhatsApp message through multiple layers, each progressively more expensive:

#### Layer 1: Intent Parser (FREE — `intentParser.js`)

Regex-based extraction of product details from Hindi/Hinglish/English text.

**High confidence (0.95) — skips GPT entirely:**
- Clear product + size: "5.5 wr rate", "hb 12g", "5.3 se 5.4mm"
- Exact greeting: "hello", "namaste", "good morning"
- Exact thanks: "thanks", "dhanyawad"

**Low confidence (→ sends to GPT):**
- Category without size: "wr rate" (gets 0.7)
- Ambiguous: "kitna book karna hoga" (gets 0)
- Follow-up: "?", ".", "rate" (gets 0.5)

**Extracted fields:** intent, category (wr/hb), size, gauge, mm, carbonType, quantity, unit, sizeAvailable, closestSizes

#### Layer 1b: Reply-to Context Enrichment

If user replies to an old message with "?" or "rate":
1. Parse the replied-to message
2. Extract product details from it
3. Use those details for the current price inquiry

#### Layer 2: Template Response (FREE — `responseBuilder.js`)

When confidence ≥ 0.95, builds a structured WhatsApp message directly:
- **Price inquiry** → Formatted price breakdown
- **Greeting** → Welcome + default WR 5.5mm & HB 12g rates
- **Thanks** → Polite thank you
- **Order inquiry** → Minimum quantity rules
- **Order confirm** → Forwards to GPT for verification

#### Layer 2b: Delivery Check (FREE — DB lookup)

If message mentions delivery (gadi, maal, truck, dispatch):
- Checks MongoDB for active orders with delivery details
- If delivery info exists in DB → sends structured delivery response
- If not → falls through to GPT

#### Layer 3: GPT Intent Classification (PAID — `openaiService.classifyIntent`)

Uses OpenAI function calling to classify:
- Intent (price_inquiry, order_confirm, order_inquiry, negotiation, delivery_inquiry, greeting, thanks, follow_up, unknown)
- Product details (category, size, gauge, mm, carbon_type)
- Emotion (neutral, happy, frustrated, urgent, confused)
- needs_admin flag

**RAG Context includes:**
- All WR sizes and their availability
- All HB gauges with mm-to-gauge mappings
- Hindi/Hinglish examples for every intent
- Order rules (min 2T/item, 5T total, ₹50K advance)
- Active orders and party details from DB

#### Layer 3 — Order Verification (PAID — `openaiService.verifyOrder`)

When order_confirm is detected, a separate GPT call extracts all order items with quantities.

#### Layer 3b: Conversational GPT (PAID — `openaiService.generateResponse`)

For truly ambiguous messages where no template fits:
- Acts as a polite steel salesperson
- NEVER quotes prices (system handles that)
- NEVER makes delivery promises without DB data
- CAN share delivery info from DB context
- Falls back to "Team se confirm karke batata hoon"

### When AI Stays Silent

If AI cannot generate a response:
1. **No WhatsApp message** is sent to the customer
2. A `chat:needs_attention` event is emitted to the dashboard
3. Employee sees the notification and can take over
4. Customer never feels like they're talking to a bot

---

## 7. Pricing Engine <a name="pricing-engine"></a>

### WR (Wire Rod) Pricing

```
Rate = (wrBaseRate + sizePremium + carbonExtra + fixedCharge) + GST
GST  = (wrBaseRate + sizePremium + carbonExtra + fixedCharge) × 18%
```

| Size | sizePremium |
|------|------------|
| 5.5mm (base) | 0 |
| 7mm | +800 |
| 8mm | +800 |
| 10mm | +800 |
| 12mm | +1,200 |
| 14mm | +1,500 |
| 16mm | +1,700 |
| 18mm | +2,200 |

**Carbon types:** Normal (+0), LC Low Carbon (+800)

**Example:** WR 12mm LC at base ₹40,000:
- mergedBase = 40,000 + 1,200 + 800 = 42,000
- subtotal = 42,000 + 345 = 42,345
- GST = 42,345 × 18% = 7,622
- **Total = ₹49,967/ton**

### HB Wire Pricing

```
HB Base = wrBaseRate + hbPremium (2,500)
Rate = (HB Base + gaugePremium + fixedCharge) + GST
```

| Gauge | Premium | MM Range |
|-------|---------|----------|
| 6g - 12g | 0 | 2.4mm - 5.2mm |
| 13g | +1,000 | 2.2 - 2.4mm |
| 14g | +1,700 | 1.9 - 2.2mm |
| 5g - 1g | +800 | 5.2 - 7.8mm |
| 1/0g - 2/0g | +800 | 7.8 - 9.2mm |
| 3/0g - 6/0g | +1,200 | 9.2 - 11.8mm |

### Unavailable Size Handling

If a customer asks for WR 6mm (not available), the system:
1. Detects it's unavailable
2. Finds nearest sizes (5.5mm and 7mm)
3. Shows prices for both suggestions
4. Asks which size they want

### Base Rate Cache

- Active base rate is cached in-memory for 30 seconds
- Cache is cleared immediately when admin updates the rate
- All prices recalculate from the new base rate automatically

---

## 8. WhatsApp Integration <a name="whatsapp-integration"></a>

### Webhook (HTTP — the only HTTP endpoint)

- **GET /webhook** — Meta verification handshake
- **POST /webhook** — Receives all WhatsApp events (messages + status updates)

### Message Types Supported

- Text messages
- Images (downloaded and stored locally)
- Documents (PDF, XLSX, DOCX)
- Audio/Video
- Location
- Reply-to context (user replies to specific message)
- Interactive buttons

### Status Tracking

Every outgoing message tracks: pending → sent → delivered → read → failed

Real-time status updates are emitted to the admin dashboard via `chat:status_update`.

---

## 9. Chat System <a name="chat-system"></a>

### For Admins (Dashboard)

- **Real-time chat list** with unread counts, last message previews, timestamps
- **Pipeline view** — conversations grouped by stage (talking, price_inquiry, order_confirmed, etc.)
- **Message history** with pagination (50 per page, load more by scrolling up)
- **Send messages** — text, images, documents with reply-to support
- **Typing indicators** — real-time "employee is typing" display
- **Read receipts** — mark messages as read, sync with WhatsApp
- **Search** — search users by name, phone, company, party name, contact name

### Display Name Resolution

Priority order for showing customer names:
1. **Party Name** (e.g., "Vijay Ji Hyderabad Steel")
2. **Firm Name** (e.g., "Hyderabad Steel Traders")
3. **Imported Contact Name** (from employee's phone contacts)
4. **WhatsApp Contact Name** (manually set)
5. **WhatsApp Profile Name** (from WA API)
6. **Phone Number** (fallback)

---

## 10. Employee Handoff System <a name="employee-handoff-system"></a>

### How It Works

1. **AI handles by default** — All new conversations start with `handlerType: "ai"`
2. **AI stays silent when unsure** — If AI can't answer, it notifies dashboard but sends NO message to customer
3. **Employee takes over** — Employee clicks "I will handle" → `chat:take_over` event
   - Sets `handlerType: "employee"` and `employeeTakenAt`
   - AI stops processing messages for this conversation
4. **Employee sends message** — Automatically marks conversation as employee-handled
5. **Employee releases** — Clicks "Release to AI" → `chat:release_to_ai` event
   - AI resumes processing for this conversation
6. **Auto-reset** — If employee doesn't interact for 12 hours:
   - Background scheduler runs every 15 minutes
   - Expired employee locks are automatically cleared
   - Conversation returns to AI handling
   - Dashboard is notified via `chat:bulk_reset`

### Events Flow

```
Customer message → chatService
  │
  ├── Is employee locked (< 12hrs)? → SKIP AI, notify dashboard only
  │
  ├── Is employee lock expired (> 12hrs)? → Auto-reset to AI, process normally
  │
  └── AI handles → Layer 1 → Layer 2 → Layer 3
        │
        ├── AI has answer → Send to customer
        │
        └── AI unsure → Stay SILENT, emit chat:needs_attention
```

---

## 11. Order Management (ERP) <a name="order-management"></a>

### Order Lifecycle

```
inquiry → quoted → advance_pending → advance_received → confirmed
→ processing → dispatched → delivered → [closed]
                                         ↑ cancelled
```

### AI Order Creation Flow

1. Customer says "5.5 3 ton book karo"
2. Intent parser detects order_confirm intent
3. GPT verifies from last 7 messages — extracts items + quantities
4. System validates minimum quantities (2T per item, 5T total)
5. Prices are calculated for each item
6. **Order is saved to MongoDB FIRST**
7. `linkedOrder` is set on the conversation
8. Order confirmation message is sent to customer
9. Dashboard is notified via `order:new`

### Employee Order Actions

| Action | Socket Event | Description |
|--------|-------------|-------------|
| Confirm order | `order:confirm` | Manually confirm an order |
| Record payment | `order:record_payment` | Record advance/balance payment |
| Update delivery | `order:update_delivery` | Set driver, vehicle, delivery date |
| Mark dispatched | `order:dispatch` | Mark as dispatched |
| Mark delivered | `order:mark_delivered` | Mark as delivered |
| Close order | `order:close` | Close completed order |
| View history | `order:list_by_user` | All orders for a customer |

### Delivery Tracking

Employees can set:
- **Driver Name** — Name of the truck driver
- **Driver Phone** — Driver's phone number
- **Vehicle Number** — Truck registration number
- **Scheduled Date** — Expected delivery date

When a customer asks "gadi kab aayegi" and delivery info is in the DB, the AI responds with the actual delivery details.

### Dashboard Summary

`order:dashboard` returns:
- Order counts by status
- 10 most recent orders with customer details
- Total revenue across all non-cancelled orders

---

## 12. Client App (Flutter) Backend <a name="client-app-backend"></a>

### Registration Flow

1. Client opens Flutter app
2. Enters phone number → Firebase OTP sent
3. OTP verified → Firebase token obtained
4. Client connects to `/client` Socket.IO namespace with Firebase token
5. Server creates/finds Client record
6. Client fills profile (Name, Firm Name, Email, GST No.)
7. Profile submitted → Admin notified in real-time
8. Admin approves/rejects → Client notified in real-time
9. Approved clients can view prices

### Client Namespace Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `profile:get` | Client → Server | Get own profile |
| `profile:submit` | Client → Server | Submit profile for approval |
| `price:get_table` | Client → Server | Get full price table (approved only) |
| `price:calculate` | Client → Server | Calculate specific price (approved only) |
| `approval:check` | Client → Server | Check approval status |
| `approval:status` | Server → Client | Push approval status changes |
| `price:updated` | Server → Client | Push price update with full table |
| `fcm:register` | Client → Server | Register FCM token |
| `fcm:unregister` | Client → Server | Remove FCM token (logout) |
| `account:blocked` | Server → Client | Account has been blocked |

---

## 13. Contact Management <a name="contact-management"></a>

### Phone Contact Sync

Employees can import contacts from their phone (via Flutter `flutter_contacts` package):

1. Flutter app reads phone contacts
2. Sends to server via `contact:sync` event
3. Server normalizes phone numbers and bulk-upserts into `Contact` collection
4. Contacts are linked to phone numbers for display name resolution

### Contact Events

| Event | Description |
|-------|-------------|
| `contact:sync` | Bulk import contacts (batched, 500/batch) |
| `contact:search` | Search by name or phone |
| `contact:get_by_phone` | Get contact name for a phone number |
| `contact:update` | Manually update a contact name |
| `contact:list` | Paginated list of employee's contacts |

---

## 14. Push Notifications (FCM) <a name="push-notifications"></a>

### Price Update Notifications

When admin updates the WR base rate:
1. All prices recalculate automatically
2. Full price table is broadcast to all connected clients via Socket.IO
3. FCM push notification sent to ALL approved clients' Flutter apps
4. Push includes summary: new base rate, WR 5.5mm total, HB 12g total
5. Invalid FCM tokens are automatically cleaned up

### Notification Types

- `price_update` — Base rate changed
- `order_update` — Order status changed
- `approval_update` — Client approval status changed
- `general` — General announcements

---

## 15. Socket.IO Events Reference <a name="socketio-events-reference"></a>

### Employee Namespace (`/`) — JWT Auth

#### Chat Events

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `chat:list` | → Server | { status?, stage?, handlerType?, page, limit } | List conversations with filters |
| `chat:pipeline` | → Server | {} | Conversations grouped by stage |
| `chat:join` | → Server | conversationId | Join conversation room |
| `chat:leave` | → Server | conversationId | Leave conversation room |
| `chat:messages` | → Server | { conversationId, before?, limit } | Get message history |
| `chat:send` | → Server | { conversationId, text, replyTo?, media? } | Send message via WhatsApp |
| `chat:take_over` | → Server | conversationId | Employee takes control |
| `chat:release_to_ai` | → Server | conversationId | Release back to AI |
| `chat:mark_read` | → Server | conversationId | Mark messages as read |
| `chat:typing` | → Server | conversationId | Typing indicator |
| `chat:update_stage` | → Server | { conversationId, stage } | Change pipeline stage |
| `chat:update_party` | → Server | { userId, partyName, firmName, billName, gstNo, ... } | Save party details |
| `chat:get_user_info` | → Server | userId | Get user with display name |
| `chat:assign` | → Server | { conversationId, employeeId, handlerType } | Assign to employee |
| `chat:search_users` | → Server | query | Search users + contacts |
| `chat:notification` | Server → | { type, conversation, displayName, message, parsedIntent } | New message notification |
| `chat:new_message` | Server → | { conversationId, message } | Message in joined conversation |
| `chat:conversation_updated` | Server → | { conversationId, ...changes } | Conversation metadata changed |
| `chat:needs_attention` | Server → | { conversationId, userName, phone, lastMessage, intent, emotion } | AI can't handle this |
| `chat:status_update` | Server → | { conversationId, messageId, deliveryStatus } | WhatsApp delivery status |
| `chat:handler_changed` | Server → | { conversationId, handlerType } | AI/employee handoff changed |
| `chat:bulk_reset` | Server → | { count } | 12hr auto-reset batch |

#### Order Events

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `order:list` | → Server | { status?, page, limit } | List orders |
| `order:get` | → Server | orderId | Get order details |
| `order:list_by_user` | → Server | { userId, page, limit } | Orders for a customer |
| `order:create` | → Server | orderData | Create order manually |
| `order:confirm` | → Server | { orderId } | Confirm an order |
| `order:update_status` | → Server | { orderId, status } | Change order status |
| `order:record_payment` | → Server | { orderId, amount, method, reference, note, isAdvance } | Record payment |
| `order:update_delivery` | → Server | { orderId, driverName, driverPhone, vehicleNumber, scheduledDate } | Set delivery details |
| `order:dispatch` | → Server | { orderId } | Mark as dispatched |
| `order:mark_delivered` | → Server | { orderId } | Mark as delivered |
| `order:close` | → Server | { orderId } | Close order |
| `order:dashboard` | → Server | {} | Dashboard summary |
| `order:new` | Server → | { orderId, orderNumber, items, grandTotal, ... } | New order created |
| `order:updated` | Server → | { orderId, status, ... } | Order was updated |

#### Price Events

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `price:get_table` | → Server | {} | Get full price table |
| `price:calculate` | → Server | { category, size, carbonType, gauge, mm } | Calculate a price |
| `price:update_base` | → Server | { wrBaseRate, ...overrides } | Update base rate (admin/manager) |
| `price:get_base` | → Server | {} | Get current base rate |
| `price:history` | → Server | { limit } | Rate change history |
| `price:updated` | Server → | { baseRate, table, updatedBy } | Price was updated |

#### Contact Events

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `contact:sync` | → Server | { contacts: [{ phone, name }] } | Bulk import contacts |
| `contact:search` | → Server | query | Search contacts |
| `contact:get_by_phone` | → Server | phone | Get contact by phone |
| `contact:update` | → Server | { phone, contactName } | Update contact name |
| `contact:list` | → Server | { page, limit } | List contacts |

#### Client Management Events

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `client:list` | → Server | { approvalStatus?, search?, page, limit } | List clients |
| `client:pending` | → Server | {} | Pending approval requests |
| `client:get` | → Server | clientId | Get client details |
| `client:counts` | → Server | {} | Dashboard badge counts |
| `client:approve` | → Server | { clientId } | Approve client (admin/manager) |
| `client:reject` | → Server | { clientId, reason } | Reject client (admin/manager) |
| `client:block` | → Server | clientId | Block client (admin) |
| `client:unblock` | → Server | clientId | Unblock client (admin) |

---

## 16. Deployment <a name="deployment"></a>

### Production Setup (Digital Ocean)

```
Domain: www.radhikasteel.in
Droplet: Ubuntu
Node.js: Latest LTS
Port: 3200 (internal)
Process: PM2
Proxy: Nginx → localhost:3200
```

### Nginx Config

```nginx
server {
    listen 80;
    server_name radhikasteel.in www.radhikasteel.in;

    location / {
        proxy_pass http://localhost:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

### PM2 ecosystem.config.js

```javascript
module.exports = {
  apps: [{
    name: "radhika-steel",
    script: "server.js",
    cwd: "/steel/radhika_steel/radhika_steels",
    env: { NODE_ENV: "production" },
    instances: 1,
    max_memory_restart: "500M",
  }],
};
```

### WhatsApp Webhook URL

```
https://www.radhikasteel.in/webhook
```

### Important Notes

- **WhatsApp token**: Must be a permanent System User token from Facebook Business Manager (temporary tokens expire in ~24 hours)
- **OpenAI API key**: Must be under "Default project" for model access
- **Firebase**: `firebase-service-account.json` must be at the project root (gitignored)
- **12hr scheduler**: Runs automatically via `setInterval` in `server.js` (every 15 minutes)
- **Rate cache**: Cleared on every `price:update_base`; auto-refreshes from DB every 30 seconds
