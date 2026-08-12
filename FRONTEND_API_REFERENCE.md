# Radhika Steel — Frontend API Reference

> Complete API reference for Flutter/frontend developers.
> **Base URL**: `https://www.radhikasteel.in` (port 3200 via Nginx reverse proxy)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Authentication](#2-authentication)
   - 2.1 [Employee Auth (HTTP + JWT)](#21-employee-auth-http--jwt)
   - 2.2 [Client Auth (Firebase OTP)](#22-client-auth-firebase-otp)
3. [Socket.IO Connection](#3-socketio-connection)
   - 3.1 [Employee Namespace `/`](#31-employee-namespace-)
   - 3.2 [Client Namespace `/client`](#32-client-namespace-client)
4. [Employee Socket Events](#4-employee-socket-events)
   - 4.1 [Chat Management](#41-chat-management)
   - 4.2 [Order Management (ERP)](#42-order-management-erp)
   - 4.3 [Pricing](#43-pricing)
   - 4.4 [Product Management](#44-product-management)
   - 4.5 [Client Approval](#45-client-approval)
   - 4.6 [Contact Management](#46-contact-management)
5. [Client Socket Events](#5-client-socket-events)
6. [Server-Emitted Events (Listen)](#6-server-emitted-events-listen)
   - 6.1 [Employee-Side Events](#61-employee-side-events)
   - 6.2 [Client-Side Events](#62-client-side-events)
7. [HTTP Endpoints](#7-http-endpoints)
8. [Data Models & Schemas](#8-data-models--schemas)
9. [Enums & Constants](#9-enums--constants)

---

## 1. Architecture Overview

```
┌─────────────────┐     Socket.IO "/"      ┌──────────────────┐
│  Employee App    │ ◄────────────────────► │                  │
│  (Flutter/Web)   │     JWT Auth           │                  │
└─────────────────┘                         │   Node.js Server │
                                            │   (Express +     │
┌─────────────────┐   Socket.IO "/client"   │    Socket.IO)    │
│  Client App      │ ◄────────────────────► │                  │
│  (Flutter)       │   Firebase Token Auth  │                  │
└─────────────────┘                         └──────────────────┘
                                                    │
┌─────────────────┐      HTTP POST /webhook         │
│  WhatsApp Cloud  │ ──────────────────────────────► │
│  API             │ ◄─────────────────────────────  │
└─────────────────┘       REST API calls
```

- **All frontend ↔ backend communication** uses Socket.IO (real-time, bidirectional).
- **Only exception**: WhatsApp webhook (`POST /webhook`) and employee auth (`POST /auth/*`).
- Employee app connects to namespace `/` with JWT token.
- Client app connects to namespace `/client` with Firebase ID token.

### Standard Response Format

Every Socket.IO callback returns:

```json
// Success
{
  "success": true,
  "data": { ... }
}

// Success with pagination
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 30,
    "total": 150,
    "totalPages": 5
  }
}

// Error
{
  "success": false,
  "error": "Error description string"
}
```

---

## 2. Authentication

### 2.1 Employee Auth (HTTP + JWT)

Employees authenticate via HTTP REST, then use the returned JWT for Socket.IO.

#### `POST /api/auth/login`

**Request Body:**
```json
{
  "email": "admin@radhikasteels.com",
  "password": "Admin@1234"
}
```

**Validation Rules:**
- `email`: required, valid email
- `password`: required, min 8 characters

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6...",
    "employee": {
      "id": "664a1f2e...",
      "name": "Vijay Kumar",
      "email": "admin@radhikasteel.in",
      "role": "admin"
    }
  }
}
```

#### `POST /api/auth/register`

**Request Body:**
```json
{
  "name": "Vijay Kumar",
  "email": "vijay@radhikasteel.in",
  "password": "securepass123",
  "phone": "919876543210",
  "role": "sales"
}
```

**Validation Rules:**
- `name`: required, 2-100 chars
- `email`: required, valid email
- `password`: required, 8-128 chars
- `phone`: optional
- `role`: optional, one of `"admin"`, `"manager"`, `"sales"`, `"support"` (default: `"sales"`)

**Success Response (201):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6...",
    "employee": {
      "id": "664a1f2e...",
      "name": "Vijay Kumar",
      "email": "vijay@radhikasteel.in",
      "role": "sales"
    }
  }
}
```

#### `GET /api/auth/me`

**Headers:** `Authorization: Bearer <JWT_TOKEN>`

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "664a1f2e...",
    "name": "Vijay Kumar",
    "email": "vijay@radhikasteel.in",
    "role": "admin"
  }
}
```

### 2.2 Client Auth (Firebase OTP)

Client app uses **Firebase Phone Authentication** (handled entirely by Firebase SDK on the client side). After getting the Firebase ID token from successful OTP verification, connect to Socket.IO `/client` namespace.

**Flow:**
1. Flutter app: Firebase phone auth → get ID token
2. Connect to `wss://www.radhikasteel.in/client` with `auth.token = firebaseIdToken`
3. Server verifies token, creates/finds Client record
4. On connect, server emits `approval:status` with current status

---

## 3. Socket.IO Connection

### 3.1 Employee Namespace `/`

```dart
// Flutter (socket_io_client)
import 'package:socket_io_client/socket_io_client.dart' as IO;

final socket = IO.io('https://www.radhikasteel.in', <String, dynamic>{
  'transports': ['websocket'],
  'auth': {'token': jwtToken},
});

socket.onConnect((_) => print('Connected'));
socket.onConnectError((err) => print('Auth failed: $err'));
```

**Auth errors emitted on connect failure:**
- `"AUTH_REQUIRED"` — no token provided
- `"AUTH_INVALID"` — invalid/expired JWT or inactive employee

### 3.2 Client Namespace `/client`

```dart
final clientSocket = IO.io('https://www.radhikasteel.in/client', <String, dynamic>{
  'transports': ['websocket'],
  'auth': {'token': firebaseIdToken},
});

// On successful connect, server auto-emits "approval:status"
clientSocket.on('approval:status', (data) {
  // data = { approvalStatus, isProfileComplete, rejectionReason }
});
```

**Auth errors:**
- `"AUTH_REQUIRED"` — no token
- `"PHONE_REQUIRED"` — Firebase token has no phone number
- `"ACCOUNT_BLOCKED"` — client is blocked
- `"AUTH_INVALID"` — invalid Firebase token

---

## 4. Employee Socket Events

All events use the **acknowledgement callback** pattern:

```dart
socket.emitWithAck('event:name', payload).then((response) {
  if (response['success']) {
    // handle response['data']
  } else {
    // handle response['error']
  }
});
```

### 4.1 Chat Management

#### `chat:list` — Get paginated conversation list

**Emit:**
```json
{
  "status": "active",
  "stage": "price_inquiry",
  "handlerType": "ai",
  "page": 1,
  "limit": 30
}
```

All fields are **optional**. Omit a field to skip that filter.

| Field | Type | Options | Default |
|-------|------|---------|---------|
| `status` | string | `"active"`, `"closed"`, `"escalated"` | — |
| `stage` | string | See [stage enum](#conversation-stages) | — |
| `handlerType` | string | `"ai"`, `"employee"` | — |
| `page` | number | >= 1 | 1 |
| `limit` | number | >= 1 | 30 |

**Callback Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "664b...",
      "user": {
        "_id": "664a...",
        "name": "Vijay",
        "phone": "917470691408",
        "waId": "917470691408",
        "partyName": "Vijay Ji Hyderabad Steel",
        "firmName": "Hyderabad Steel Corp",
        "billName": "Hyderabad Steel Corp",
        "gstNo": "36AABCH1234M1Z5",
        "contactName": ""
      },
      "status": "active",
      "stage": "price_inquiry",
      "handlerType": "ai",
      "employeeTakenAt": null,
      "assignedTo": { "_id": "...", "name": "Ramesh" },
      "linkedOrder": {
        "_id": "...",
        "orderNumber": "RS-M1A2B3-XY4Z",
        "status": "advance_pending",
        "pricing": { "grandTotal": 247870 },
        "advancePayment": { "amount": 0, "isPaid": false },
        "delivery": { "driverName": "", "scheduledDate": null }
      },
      "unreadCount": 3,
      "lastMessage": {
        "text": "5.5 wr rate?",
        "senderType": "user",
        "mediaType": "none",
        "timestamp": "2026-04-06T10:30:00.000Z"
      },
      "messageCount": 45,
      "lastMessageAt": "2026-04-06T10:30:00.000Z",
      "displayName": "Vijay Ji Hyderabad Steel",
      "importedContacts": [
        { "phone": "917470691408", "contactName": "Vijay Ji Hyderabad Steel", "syncedBy": "..." }
      ]
    }
  ],
  "pagination": { "page": 1, "limit": 30, "total": 85, "totalPages": 3 }
}
```

**`displayName` resolution order:** partyName → firmName → imported contact name → contactName → user.name → phone number

---

#### `chat:pipeline` — Conversations grouped by stage (Kanban board)

**Emit:** `null` or `{}`

**Callback Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "price_inquiry",
      "count": 12,
      "conversations": [
        {
          "_id": "664b...",
          "user": { "_id": "...", "name": "Vijay", "phone": "917470691408", "partyName": "...", "firmName": "..." },
          "lastMessage": { "text": "5.5 rate?", "senderType": "user", "timestamp": "..." },
          "unreadCount": 2,
          "lastMessageAt": "...",
          "linkedOrder": "664c...",
          "handlerType": "ai",
          "employeeTakenAt": null,
          "assignedTo": null
        }
      ]
    },
    {
      "_id": "order_confirmed",
      "count": 5,
      "conversations": [ ... ]
    }
  ]
}
```

---

#### `chat:join` — Join a conversation room (for real-time updates)

**Emit:** `"664b..."` (conversationId as string)

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "_id": "664b...",
    "user": {
      "_id": "664a...",
      "name": "Vijay",
      "phone": "917470691408",
      "waId": "917470691408",
      "partyName": "Vijay Ji Hyderabad Steel",
      "firmName": "Hyderabad Steel Corp",
      "billName": "Hyderabad Steel Corp",
      "gstNo": "36AABCH1234M1Z5",
      "contactName": "",
      "company": "",
      "city": "Hyderabad"
    },
    "status": "active",
    "stage": "price_inquiry",
    "handlerType": "ai",
    "employeeTakenAt": null,
    "assignedTo": { "_id": "...", "name": "Ramesh" },
    "linkedOrder": {
      "_id": "...",
      "orderNumber": "RS-M1A2B3-XY4Z",
      "status": "advance_pending",
      "pricing": { "subtotal": 0, "taxAmount": 0, "grandTotal": 247870 },
      "advancePayment": { "amount": 50000, "isPaid": true, "paidAt": "..." },
      "delivery": {
        "driverName": "Raju",
        "driverPhone": "919999888877",
        "vehicleNumber": "CG04AB1234",
        "scheduledDate": "2026-04-08T00:00:00.000Z"
      }
    },
    "context": {
      "lastIntent": "price_inquiry",
      "lastDetectedProduct": {
        "category": "wr",
        "size": "5.5",
        "gauge": "",
        "mm": "",
        "carbonType": "normal",
        "quantity": 10,
        "unit": "ton"
      }
    },
    "unreadCount": 3,
    "lastMessage": { "text": "...", "senderType": "user", "timestamp": "..." },
    "messageCount": 45,
    "displayName": "Vijay Ji Hyderabad Steel",
    "importedContacts": [ ... ]
  }
}
```

---

#### `chat:leave` — Leave a conversation room

**Emit:** `"664b..."` (conversationId)

No callback. Fire-and-forget.

---

#### `chat:messages` — Get paginated messages (newest first, reversed to chronological)

**Emit:**
```json
{
  "conversationId": "664b...",
  "before": "2026-04-06T10:00:00.000Z",
  "limit": 50
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `conversationId` | string | Yes | Conversation ID |
| `before` | ISO date string | No | Cursor for pagination — fetch messages before this timestamp |
| `limit` | number | No | Default 50 |

**Callback Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "664c...",
      "conversation": "664b...",
      "sender": {
        "type": "user",
        "employeeId": null
      },
      "content": {
        "text": "5.5 wr rate?",
        "mediaType": "none",
        "mediaUrl": "",
        "mediaLocalPath": "",
        "waMediaId": "",
        "mimeType": "",
        "fileName": "",
        "fileSize": 0,
        "caption": ""
      },
      "replyTo": null,
      "waMessageId": "wamid.HBgLOTE3NDcwNjkx...",
      "waTimestamp": "2026-04-06T10:30:00.000Z",
      "deliveryStatus": "delivered",
      "sentAt": null,
      "deliveredAt": "2026-04-06T10:30:01.000Z",
      "readAt": null,
      "readByAdmin": false,
      "readByAdminAt": null,
      "aiMetadata": {
        "model": "",
        "tokensUsed": 0,
        "responseTimeMs": 0,
        "intent": "",
        "detectedAction": ""
      },
      "createdAt": "2026-04-06T10:30:00.000Z"
    },
    {
      "_id": "664d...",
      "sender": {
        "type": "ai",
        "employeeId": null
      },
      "content": {
        "text": "Radhika Steel Raipur\n\nWR 5.5mm\n₹40,000 + ₹345 + 18% GST\nTotal: ₹47,607/ton\n\nKaunsa size chahiye aapko?",
        "mediaType": "none"
      },
      "replyTo": null,
      "deliveryStatus": "delivered",
      "aiMetadata": {
        "model": "gpt-4o-mini",
        "tokensUsed": 1850,
        "responseTimeMs": 1200,
        "intent": "price_inquiry"
      },
      "createdAt": "2026-04-06T10:30:02.000Z"
    },
    {
      "_id": "664e...",
      "sender": {
        "type": "employee",
        "employeeId": { "_id": "...", "name": "Ramesh" }
      },
      "content": {
        "text": "Vijay ji, rate abhi fresh hai. Bataye kitna chahiye?",
        "mediaType": "none"
      },
      "replyTo": {
        "_id": "664c...",
        "content": { "text": "5.5 wr rate?", "mediaType": "none" },
        "sender": { "type": "user" }
      },
      "deliveryStatus": "read",
      "readAt": "2026-04-06T10:35:00.000Z",
      "createdAt": "2026-04-06T10:32:00.000Z"
    }
  ],
  "hasMore": true
}
```

**Pagination:** Pass `data[0].createdAt` as `before` in the next request to fetch older messages.

---

#### `chat:send` — Send message from employee to WhatsApp user

**Emit:**
```json
{
  "conversationId": "664b...",
  "text": "Vijay ji, aapka order confirm hai.",
  "replyTo": "664c...",
  "mediaType": null,
  "mediaBuffer": null,
  "fileName": null,
  "mimeType": null,
  "caption": null
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `conversationId` | string | Yes | Conversation ID |
| `text` | string | Yes (if no media) | Message text |
| `replyTo` | string | No | Message ID to reply to |
| `mediaType` | string | No | `"image"`, `"document"`, `"audio"`, `"video"` |
| `mediaBuffer` | Buffer/Uint8List | No | Binary data of the media file |
| `fileName` | string | No | File name (for documents) |
| `mimeType` | string | No | MIME type (e.g., `"image/jpeg"`, `"application/pdf"`) |
| `caption` | string | No | Caption for media messages |

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "_id": "664f...",
    "conversation": "664b...",
    "sender": { "type": "employee", "employeeId": "..." },
    "content": { "text": "Vijay ji, aapka order confirm hai.", "mediaType": "none" },
    "replyTo": "664c...",
    "waMessageId": "wamid.xxx",
    "deliveryStatus": "sent",
    "createdAt": "2026-04-06T10:40:00.000Z"
  }
}
```

> **Note:** Sending a message **automatically marks the conversation as employee-handled** (`handlerType: "employee"`, `employeeTakenAt` refreshed). AI will stop responding until released or 12-hour timeout.

---

#### `chat:take_over` — Employee takes control (AI stops)

**Emit:** `"664b..."` (conversationId)

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "conversationId": "664b...",
    "handlerType": "employee",
    "employeeTakenAt": "2026-04-06T10:45:00.000Z"
  }
}
```

---

#### `chat:release_to_ai` — Release conversation back to AI

**Emit:** `"664b..."` (conversationId)

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "conversationId": "664b...",
    "handlerType": "ai"
  }
}
```

---

#### `chat:mark_read` — Mark all user messages as read

**Emit:** `"664b..."` (conversationId)

**Callback Response:**
```json
{
  "success": true,
  "data": { "markedRead": 5 }
}
```

Also emits `chat:unread_reset` to all in the conv room and `chat:conversation_updated` to all employees.

---

#### `chat:typing` — Broadcast typing indicator

**Emit:** `"664b..."` (conversationId)

No callback. Fire-and-forget. Other employees in the same conv room receive `chat:typing` event.

---

#### `chat:update_stage` — Update conversation pipeline stage

**Emit:**
```json
{
  "conversationId": "664b...",
  "stage": "order_confirmed"
}
```

Valid stages: `"talking"`, `"price_inquiry"`, `"negotiation"`, `"order_confirmed"`, `"advance_pending"`, `"advance_received"`, `"payment_complete"`, `"dispatched"`, `"delivered"`, `"closed"`

**Callback Response:**
```json
{
  "success": true,
  "data": { "_id": "664b...", "stage": "order_confirmed", ... }
}
```

---

#### `chat:update_party` — Save party/firm/GST details for a user

**Emit:**
```json
{
  "userId": "664a...",
  "partyName": "Vijay Ji Hyderabad Steel",
  "firmName": "Hyderabad Steel Corp",
  "billName": "Hyderabad Steel Corp",
  "gstNo": "36AABCH1234M1Z5",
  "contactName": "Vijay Ji",
  "city": "Hyderabad",
  "company": "Hyderabad Steel Corp"
}
```

All fields except `userId` are optional — only provided fields are updated.

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "_id": "664a...",
    "name": "Vijay",
    "phone": "917470691408",
    "partyName": "Vijay Ji Hyderabad Steel",
    "firmName": "Hyderabad Steel Corp",
    "billName": "Hyderabad Steel Corp",
    "gstNo": "36AABCH1234M1Z5"
  }
}
```

Also broadcasts `chat:party_updated` to all employees.

---

#### `chat:get_user_info` — Get full user info with display name

**Emit:** `"664a..."` (userId)

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "664a...",
      "name": "Vijay",
      "phone": "917470691408",
      "waId": "917470691408",
      "partyName": "Vijay Ji Hyderabad Steel",
      "firmName": "Hyderabad Steel Corp",
      "billName": "Hyderabad Steel Corp",
      "gstNo": "36AABCH1234M1Z5",
      "city": "Hyderabad",
      "contactName": ""
    },
    "displayName": "Vijay Ji Hyderabad Steel",
    "importedContacts": [
      { "phone": "917470691408", "contactName": "Vijay Ji Hyderabad", "syncedBy": "..." }
    ]
  }
}
```

---

#### `chat:assign` — Assign conversation to a specific employee

**Emit:**
```json
{
  "conversationId": "664b...",
  "employeeId": "664e...",
  "handlerType": "employee"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `conversationId` | string | Yes | Conversation ID |
| `employeeId` | string | No | Employee ID (null to unassign) |
| `handlerType` | string | No | `"ai"` or `"employee"` |

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "_id": "664b...",
    "assignedTo": { "_id": "664e...", "name": "Ramesh", "email": "ramesh@radhikasteel.in" },
    "handlerType": "employee",
    "user": { ... }
  }
}
```

---

#### `chat:search_users` — Search users/contacts

**Emit:** `"vijay"` (search query string)

Searches across: name, phone, company, partyName, firmName, contactName, and imported contacts.

**Callback Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "664a...",
      "name": "Vijay",
      "phone": "917470691408",
      "partyName": "Vijay Ji Hyderabad Steel",
      "firmName": "Hyderabad Steel Corp",
      "contactName": "",
      "lastMessageAt": "2026-04-06T10:30:00.000Z",
      "matchedContactName": "Vijay Ji Hyderabad"
    }
  ]
}
```

---

### 4.2 Order Management (ERP)

#### `order:list` — Get orders by status

**Emit:**
```json
{
  "status": "advance_pending",
  "page": 1,
  "limit": 20
}
```

All fields optional.

**Callback Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "664d...",
      "orderNumber": "RS-M1A2B3-XY4Z",
      "user": { "_id": "...", "name": "Vijay", "phone": "917470691408", "partyName": "..." },
      "items": [
        {
          "category": "wr",
          "productName": "WR 5.5mm",
          "size": "5.5",
          "gauge": null,
          "mm": null,
          "carbonType": "normal",
          "quantity": 5,
          "unit": "ton",
          "unitPrice": 47607,
          "totalPrice": 238035
        },
        {
          "category": "hb",
          "productName": "HB Wire 5g (5.2-5.6mm)",
          "size": null,
          "gauge": "5",
          "mm": "5.3",
          "carbonType": "normal",
          "quantity": 2,
          "unit": "ton",
          "unitPrice": 51237,
          "totalPrice": 102474
        }
      ],
      "pricing": {
        "subtotal": 340509,
        "taxAmount": 0,
        "freight": 0,
        "discount": 0,
        "grandTotal": 340509
      },
      "advancePayment": {
        "amount": 50000,
        "isPaid": true,
        "paidAt": "2026-04-06T11:00:00.000Z"
      },
      "payments": [],
      "status": "advance_received",
      "delivery": {
        "driverName": "Raju",
        "driverPhone": "919999888877",
        "vehicleNumber": "CG04AB1234",
        "scheduledDate": "2026-04-08T00:00:00.000Z",
        "dispatchedAt": null,
        "deliveredAt": null
      },
      "closedAt": null,
      "assignedTo": { "_id": "...", "name": "Ramesh" },
      "createdBy": "ai",
      "createdAt": "2026-04-06T10:30:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 15, "totalPages": 1 }
}
```

---

#### `order:get` — Get single order by ID

**Emit:** `"664d..."` (orderId)

**Callback Response:** Same shape as a single item from `order:list` but with populated `conversation` field.

---

#### `order:list_by_user` — All orders for a specific user/party

**Emit:**
```json
{
  "userId": "664a...",
  "page": 1,
  "limit": 20
}
```

**Callback Response:** Same shape as `order:list`.

---

#### `order:create` — Manually create an order

**Emit:**
```json
{
  "user": "664a...",
  "conversation": "664b...",
  "items": [
    {
      "category": "wr",
      "size": "5.5",
      "carbonType": "normal",
      "quantity": 5,
      "unit": "ton"
    },
    {
      "category": "hb",
      "gauge": "5",
      "mm": "5.3",
      "carbonType": "normal",
      "quantity": 2,
      "unit": "ton"
    }
  ],
  "notes": "Urgent delivery needed"
}
```

**Callback Response:**
```json
{
  "success": true,
  "data": { "_id": "...", "orderNumber": "RS-...", ... }
}
```

Also broadcasts `order:new` to all employees.

---

#### `order:confirm` — Employee confirms a pending order

**Emit:**
```json
{ "orderId": "664d..." }
```

Sets status → `advance_pending`. Updates conversation stage.

**Callback Response:**
```json
{
  "success": true,
  "data": { "_id": "...", "status": "advance_pending", ... }
}
```

---

#### `order:update_status` — Update order status

**Emit:**
```json
{
  "orderId": "664d...",
  "status": "confirmed"
}
```

Valid statuses: `"inquiry"`, `"quoted"`, `"advance_pending"`, `"advance_received"`, `"confirmed"`, `"processing"`, `"dispatched"`, `"delivered"`, `"cancelled"`

**Callback Response:**
```json
{
  "success": true,
  "data": { "_id": "...", "status": "confirmed", ... }
}
```

---

#### `order:record_payment` — Record advance or balance payment

**Emit:**
```json
{
  "orderId": "664d...",
  "amount": 50000,
  "method": "upi",
  "reference": "UPI-TXN-123456",
  "note": "Advance payment received",
  "isAdvance": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `orderId` | string | Yes | Order ID |
| `amount` | number | Yes | Payment amount in ₹ |
| `method` | string | No | `"cash"`, `"bank_transfer"`, `"upi"`, `"cheque"`, `"other"` (default: `"bank_transfer"`) |
| `reference` | string | No | Transaction reference |
| `note` | string | No | Payment note |
| `isAdvance` | boolean | No | Default `true`. If true, updates advancePayment and may change status to `advance_received` |

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "advancePayment": { "amount": 50000, "isPaid": true, "paidAt": "..." },
    "payments": [
      {
        "amount": 50000,
        "method": "upi",
        "reference": "UPI-TXN-123456",
        "note": "Advance payment received",
        "receivedAt": "...",
        "recordedBy": "..."
      }
    ],
    "status": "advance_received"
  }
}
```

---

#### `order:update_delivery` — Set delivery details

**Emit:**
```json
{
  "orderId": "664d...",
  "driverName": "Raju Kumar",
  "driverPhone": "919999888877",
  "vehicleNumber": "CG04AB1234",
  "scheduledDate": "2026-04-08"
}
```

All fields except `orderId` are optional — only provided fields are updated.

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "delivery": {
      "driverName": "Raju Kumar",
      "driverPhone": "919999888877",
      "vehicleNumber": "CG04AB1234",
      "scheduledDate": "2026-04-08T00:00:00.000Z",
      "dispatchedAt": null,
      "deliveredAt": null
    }
  }
}
```

---

#### `order:dispatch` — Mark order as dispatched

**Emit:**
```json
{ "orderId": "664d..." }
```

Sets `status: "dispatched"`, `delivery.dispatchedAt: now`. Updates conversation stage.

---

#### `order:mark_delivered` — Mark order as delivered

**Emit:**
```json
{ "orderId": "664d..." }
```

Sets `status: "delivered"`, `delivery.deliveredAt: now`. Updates conversation stage.

---

#### `order:close` — Close a completed order

**Emit:**
```json
{ "orderId": "664d..." }
```

Sets `closedAt: now`. Updates conversation stage to `"closed"`. Order remains visible in history.

---

#### `order:dashboard` — Get order dashboard stats

**Emit:** `null` or `{}`

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "statusCounts": [
      { "_id": "advance_pending", "count": 3, "totalValue": 750000 },
      { "_id": "advance_received", "count": 5, "totalValue": 1250000 },
      { "_id": "confirmed", "count": 2, "totalValue": 500000 },
      { "_id": "dispatched", "count": 1, "totalValue": 250000 },
      { "_id": "delivered", "count": 10, "totalValue": 2500000 }
    ],
    "recentOrders": [
      {
        "_id": "...",
        "orderNumber": "RS-...",
        "user": { "name": "Vijay", "phone": "917470691408", "partyName": "..." },
        "assignedTo": { "name": "Ramesh" },
        "status": "advance_pending",
        "pricing": { "grandTotal": 247870 },
        "createdAt": "2026-04-06T10:30:00.000Z"
      }
    ],
    "totalRevenue": {
      "total": 5250000,
      "count": 21
    }
  }
}
```

---

### 4.3 Pricing

#### `price:get_table` — Get full price table (all WR sizes + HB gauges)

**Emit:** `null` or `{}`

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "wrBaseRate": 40000,
    "updatedAt": "2026-04-06T08:00:00.000Z",
    "wr": [
      {
        "category": "wr",
        "size": "5.5",
        "carbonType": "normal",
        "unit": "ton",
        "mergedBase": 40000,
        "fixedCharge": 345,
        "gstPercent": 18,
        "subtotal": 40345,
        "gst": 7262,
        "total": 47607,
        "label": "WR 5.5mm"
      },
      {
        "category": "wr",
        "size": "5.5",
        "carbonType": "lc",
        "unit": "ton",
        "mergedBase": 40800,
        "fixedCharge": 345,
        "gstPercent": 18,
        "subtotal": 41145,
        "gst": 7406,
        "total": 48551,
        "label": "WR 5.5mm LC"
      },
      {
        "category": "wr",
        "size": "7",
        "carbonType": "normal",
        "mergedBase": 40800,
        "fixedCharge": 345,
        "gstPercent": 18,
        "subtotal": 41145,
        "gst": 7406,
        "total": 48551,
        "label": "WR 7mm"
      }
    ],
    "hb": [
      {
        "category": "hb",
        "gauge": "1",
        "mmRange": { "gauge": "1", "minMm": 7.2, "maxMm": 7.8 },
        "carbonType": "normal",
        "unit": "ton",
        "mergedBase": 43300,
        "fixedCharge": 345,
        "gstPercent": 18,
        "subtotal": 43645,
        "gst": 7856,
        "total": 51501,
        "label": "HB Wire 1g (7.2-7.8mm)"
      },
      {
        "category": "hb",
        "gauge": "1",
        "mmRange": { "gauge": "1", "minMm": 7.2, "maxMm": 7.8 },
        "carbonType": "lc",
        "unit": "ton",
        "mergedBase": 44100,
        "fixedCharge": 345,
        "gstPercent": 18,
        "subtotal": 44445,
        "gst": 8000,
        "total": 52445,
        "label": "HB Wire 1g (7.2-7.8mm) LC"
      },
      {
        "category": "hb",
        "gauge": "12",
        "mmRange": { "gauge": "12", "minMm": 2.4, "maxMm": 2.8 },
        "carbonType": "normal",
        "unit": "ton",
        "mergedBase": 42500,
        "fixedCharge": 345,
        "gstPercent": 18,
        "subtotal": 42845,
        "gst": 7712,
        "total": 50557,
        "label": "HB Wire 12g (2.4-2.8mm)"
      },
      {
        "category": "hb",
        "gauge": "12",
        "mmRange": { "gauge": "12", "minMm": 2.4, "maxMm": 2.8 },
        "carbonType": "lc",
        "unit": "ton",
        "mergedBase": 43300,
        "fixedCharge": 345,
        "gstPercent": 18,
        "subtotal": 43645,
        "gst": 7856,
        "total": 51501,
        "label": "HB Wire 12g (2.4-2.8mm) LC"
      }
    ]
  }
}
```

> **Note:** Each HB gauge now appears twice — once with `carbonType: "normal"` and once with `carbonType: "lc"`. Filter by `carbonType` when rendering the price list. LC variants add ₹800 to `mergedBase`. The `normal` entry for every gauge is emitted first, so legacy code that does `hb.find(p => p.gauge === "12")` still returns the normal variant.

---

#### `price:calculate` — Calculate price for a specific product

**Emit:**
```json
{
  "category": "wr",
  "size": "12",
  "carbonType": "lc",
  "gauge": null,
  "mm": null
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `category` | string | Yes | `"wr"` or `"hb"` |
| `size` | string | For WR | WR size in mm: `"5.5"`, `"7"`, `"8"`, `"10"`, `"12"`, `"14"`, `"16"`, `"18"` |
| `carbonType` | string | No | `"normal"` (default) or `"lc"` (Low Carbon) — supported for both WR and HB (LC adds ₹800/ton) |
| `gauge` | string | For HB | HB gauge: `"1"` to `"14"`, `"1/0"` to `"6/0"` |
| `mm` | string | For HB | HB mm size (e.g., `"5.3"`) — auto-maps to gauge |

**Callback Response (WR example):**
```json
{
  "success": true,
  "data": {
    "category": "wr",
    "size": "12",
    "carbonType": "lc",
    "unit": "ton",
    "mergedBase": 42000,
    "fixedCharge": 345,
    "gstPercent": 18,
    "subtotal": 42345,
    "gst": 7622,
    "total": 49967,
    "label": "WR 12mm LC"
  }
}
```

**Callback Response (HB example):**
```json
{
  "success": true,
  "data": {
    "category": "hb",
    "gauge": "5",
    "mmRange": { "gauge": "5", "minMm": 5.2, "maxMm": 5.6 },
    "carbonType": "normal",
    "unit": "ton",
    "mergedBase": 43300,
    "fixedCharge": 345,
    "gstPercent": 18,
    "subtotal": 43645,
    "gst": 7856,
    "total": 51501,
    "label": "HB Wire 5g (5.2-5.6mm)"
  }
}
```

**Callback Response (HB LC example):**

Emit `{ "category": "hb", "gauge": "5", "carbonType": "lc" }` (or `{ "category": "hb", "mm": "5.3", "carbonType": "lc" }`):
```json
{
  "success": true,
  "data": {
    "category": "hb",
    "gauge": "5",
    "mmRange": { "gauge": "5", "minMm": 5.2, "maxMm": 5.6 },
    "carbonType": "lc",
    "unit": "ton",
    "mergedBase": 44100,
    "fixedCharge": 345,
    "gstPercent": 18,
    "subtotal": 44445,
    "gst": 8000,
    "total": 52445,
    "label": "HB Wire 5g (5.2-5.6mm) LC"
  }
}
```

---

#### `price:update_base` — Admin updates WR base rate (requires `admin` or `manager` role)

**Emit:**
```json
{
  "wrBaseRate": 41000,
  "hbPremium": 2500,
  "fixedCharge": 345,
  "gstPercent": 18,
  "sizePremiums": {
    "5.5": 0, "7": 800, "8": 800, "10": 800,
    "12": 1200, "14": 1500, "16": 1700, "18": 2200
  },
  "carbonExtras": { "normal": 0, "lc": 800 },
  "hbGaugePremiums": {
    "6": 0, "7": 0, "8": 0, "9": 0, "10": 0, "11": 0, "12": 0,
    "13": 1000, "14": 1700,
    "5": 800, "4": 800, "3": 800, "2": 800, "1": 800,
    "1/0": 800, "2/0": 800,
    "3/0": 1200, "4/0": 1200, "5/0": 1200, "6/0": 1200
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `wrBaseRate` | number | Yes | New WR base rate in ₹/ton (must be > 0) |
| All other fields | various | No | Override defaults — usually only `wrBaseRate` is sent |

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "baseRate": { "_id": "...", "wrBaseRate": 41000, "isActive": true, ... },
    "table": { "wrBaseRate": 41000, "wr": [...], "hb": [...] }
  }
}
```

**Side effects:**
- Broadcasts `price:updated` to all employees and all connected clients
- Sends FCM push notification to all approved clients' Flutter apps

---

#### `price:get_base` — Get current active base rate

**Emit:** `null` or `{}`

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "_id": "664e...",
    "wrBaseRate": 40000,
    "sizePremiums": { "5.5": 0, "7": 800, ... },
    "carbonExtras": { "normal": 0, "lc": 800 },
    "hbPremium": 2500,
    "hbGaugePremiums": { "6": 0, "12": 0, "13": 1000, ... },
    "fixedCharge": 345,
    "gstPercent": 18,
    "isActive": true,
    "updatedBy": { "_id": "...", "name": "Admin" },
    "createdAt": "2026-04-06T08:00:00.000Z"
  }
}
```

---

#### `price:history` — Get base rate change history

**Emit:**
```json
{ "limit": 10 }
```

**Callback Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "...",
      "wrBaseRate": 41000,
      "isActive": true,
      "updatedBy": { "_id": "...", "name": "Admin" },
      "createdAt": "2026-04-06T08:00:00.000Z"
    },
    {
      "_id": "...",
      "wrBaseRate": 40000,
      "isActive": false,
      "updatedBy": { "_id": "...", "name": "Admin" },
      "createdAt": "2026-04-05T08:00:00.000Z"
    }
  ]
}
```

---

### 4.4 Product Management

#### `product:list` — Get products

**Emit:**
```json
{
  "category": "wr",
  "search": "5.5mm",
  "page": 1,
  "limit": 50
}
```

All fields optional.

**Callback Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "...",
      "name": "WR 5.5mm Normal",
      "category": "wr",
      "size": "5.5",
      "sizeUnit": "mm",
      "carbonType": "normal",
      "unit": "ton",
      "isActive": true,
      "description": ""
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 20 }
}
```

---

#### `product:create` — Create product (admin/manager)

**Emit:**
```json
{
  "name": "WR 5.5mm Normal",
  "category": "wr",
  "size": "5.5",
  "sizeUnit": "mm",
  "carbonType": "normal",
  "unit": "ton",
  "description": "Wire Rod 5.5mm standard"
}
```

---

#### `product:update` — Update product (admin/manager)

**Emit:**
```json
{
  "productId": "664a...",
  "name": "WR 5.5mm HC",
  "description": "Updated description"
}
```

---

#### `product:delete` — Soft-delete product (admin only)

**Emit:** `"664a..."` (productId)

---

### 4.5 Client Approval

#### `client:list` — Get paginated client list

**Emit:**
```json
{
  "approvalStatus": "pending",
  "search": "vijay",
  "page": 1,
  "limit": 25
}
```

**Callback Response:**
```json
{
  "success": true,
  "clients": [
    {
      "_id": "664f...",
      "firebaseUid": "abc123...",
      "phone": "917470691408",
      "name": "Vijay Kumar",
      "firmName": "Hyderabad Steel Corp",
      "email": "vijay@example.com",
      "gstNumber": "36AABCH1234M1Z5",
      "isProfileComplete": true,
      "approvalStatus": "pending",
      "approvedBy": null,
      "approvedAt": null,
      "rejectionReason": "",
      "isBlocked": false,
      "createdAt": "2026-04-06T10:00:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 25, "total": 8, "totalPages": 1 }
}
```

---

#### `client:pending` — Get pending clients only

**Emit:** `{}` or `{ "page": 1, "limit": 25 }`

Same response as `client:list` but pre-filtered to `approvalStatus: "pending"`.

---

#### `client:get` — Get single client

**Emit:** `"664f..."` (clientId)

---

#### `client:counts` — Dashboard badge counts

**Emit:** `null` or `{}`

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "pending": 3,
    "approved": 45,
    "rejected": 2,
    "total": 50
  }
}
```

---

#### `client:approve` — Approve client (admin/manager)

**Emit:**
```json
{ "clientId": "664f..." }
```

**Side effects:**
- Broadcasts `client:updated` with `action: "approved"` to all employees
- Emits `approval:status` with `approvalStatus: "approved"` to the client's socket

---

#### `client:reject` — Reject client (admin/manager)

**Emit:**
```json
{
  "clientId": "664f...",
  "reason": "Invalid GST number"
}
```

**Side effects:**
- Broadcasts `client:updated` with `action: "rejected"` to all employees
- Emits `approval:status` with `approvalStatus: "rejected"` to the client's socket

---

#### `client:block` — Block client (admin only)

**Emit:** `"664f..."` (clientId)

**Side effects:**
- Broadcasts `client:updated` with `action: "blocked"` to all employees
- Emits `account:blocked` to the client, forces disconnect on next reconnect

---

#### `client:unblock` — Unblock client (admin only)

**Emit:** `"664f..."` (clientId)

---

### 4.6 Contact Management

#### `contact:sync` — Bulk import contacts from phone

**Emit:**
```json
{
  "contacts": [
    { "phone": "917470691408", "name": "Vijay Ji Hyderabad Steel" },
    { "phone": "918888777766", "name": "Ramesh Builder Pune" },
    { "phone": "919999666655", "name": "Suresh Raipur Nails" }
  ]
}
```

Phone numbers are auto-cleaned (non-numeric chars removed). Uses batched `bulkWrite` for performance — can sync thousands of contacts at once.

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "total": 3,
    "new": 2,
    "updated": 1
  }
}
```

---

#### `contact:search` — Search synced contacts

**Emit:** `"vijay"` (search query string)

Searches both `contactName` and `phone` fields.

**Callback Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "...",
      "phone": "917470691408",
      "contactName": "Vijay Ji Hyderabad Steel",
      "syncedBy": "664e...",
      "createdAt": "..."
    }
  ]
}
```

---

#### `contact:get_by_phone` — Get contact name for a phone number

**Emit:** `"917470691408"` (phone number string)

**Callback Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "...",
      "phone": "917470691408",
      "contactName": "Vijay Ji Hyderabad Steel",
      "syncedBy": "664e..."
    }
  ]
}
```

Returns array (multiple employees may have different names for the same number).

---

#### `contact:update` — Manually update/create a contact

**Emit:**
```json
{
  "phone": "917470691408",
  "contactName": "Vijay Ji Steel Hyderabad"
}
```

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "phone": "917470691408",
    "contactName": "Vijay Ji Steel Hyderabad",
    "syncedBy": "664e..."
  }
}
```

---

#### `contact:list` — Get all contacts for this employee

**Emit:**
```json
{ "page": 1, "limit": 50 }
```

**Callback Response:**
```json
{
  "success": true,
  "data": [
    { "_id": "...", "phone": "917470691408", "contactName": "Vijay Ji Hyderabad Steel" },
    { "_id": "...", "phone": "918888777766", "contactName": "Ramesh Builder Pune" }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 128, "totalPages": 3 }
}
```

---

## 5. Client Socket Events

These events are on the `/client` namespace. Client must connect with a valid Firebase ID token.

#### `profile:get` — Get own profile

**Emit:** `null` or `{}`

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "_id": "664f...",
    "firebaseUid": "abc123...",
    "phone": "917470691408",
    "name": "Vijay Kumar",
    "firmName": "Hyderabad Steel Corp",
    "email": "vijay@example.com",
    "gstNumber": "36AABCH1234M1Z5",
    "isProfileComplete": true,
    "approvalStatus": "approved",
    "approvedBy": { "_id": "...", "name": "Admin", "email": "admin@radhikasteel.in" },
    "approvedAt": "2026-04-06T12:00:00.000Z",
    "isBlocked": false
  }
}
```

---

#### `profile:submit` — Submit/update profile for approval

**Emit:**
```json
{
  "name": "Vijay Kumar",
  "firmName": "Hyderabad Steel Corp",
  "email": "vijay@example.com",
  "gstNumber": "36AABCH1234M1Z5"
}
```

All four fields are **required**.

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "approvalStatus": "pending",
    "isProfileComplete": true,
    "message": "Profile submitted! Waiting for admin approval."
  }
}
```

**Side effects:** Emits `client:new_request` to all employees.

---

#### `price:get_table` — Get full price table (approved clients only)

Same format as employee `price:get_table`.

**Error if not approved:**
```json
{
  "success": false,
  "error": "ACCESS_DENIED",
  "message": "Your account must be approved by admin to view prices.",
  "approvalStatus": "pending"
}
```

---

#### `price:calculate` — Calculate specific price (approved clients only)

Same as employee `price:calculate`. Returns `ACCESS_DENIED` if not approved.

---

#### `approval:check` — Quick check current approval status

**Emit:** `null` or `{}`

**Callback Response:**
```json
{
  "success": true,
  "data": {
    "approvalStatus": "approved",
    "isProfileComplete": true,
    "rejectionReason": ""
  }
}
```

---

#### `fcm:register` — Register FCM token for push notifications

**Emit:**
```json
{
  "token": "dGhpcyBpcyBhIGZjbSB0b2tlbg...",
  "device": "Samsung Galaxy S21"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `token` | string | Yes | FCM device token from Firebase Messaging |
| `device` | string | No | Device name/model for tracking |

**Callback Response:**
```json
{ "success": true }
```

---

#### `fcm:unregister` — Remove FCM token (on logout)

**Emit:**
```json
{ "token": "dGhpcyBpcyBhIGZjbSB0b2tlbg..." }
```

**Callback Response:**
```json
{ "success": true }
```

---

## 6. Server-Emitted Events (Listen)

These events are emitted by the server — the frontend should **listen** for them.

### 6.1 Employee-Side Events

Listen on namespace `/`:

| Event | Description | Payload |
|-------|-------------|---------|
| `chat:new_message` | New message in a conversation | [See below](#chatnew_message) |
| `chat:needs_attention` | AI couldn't understand, needs employee | `{ conversationId, lastMessage, user, displayName, reason }` |
| `chat:conversation_updated` | Conversation metadata changed | `{ conversationId, ...changedFields }` |
| `chat:unread_reset` | Admin read messages | `{ conversationId, readByAdminAt }` |
| `chat:typing` | Someone typing in a room | `{ conversationId, employeeName }` |
| `chat:party_updated` | User party details changed | `{ userId, user }` |
| `chat:bulk_reset` | Auto-reset of expired employee locks | `{ count, conversationIds }` |
| `order:new` | New order created (AI or employee) | Full order object |
| `order:updated` | Order status/details changed | `{ orderId, orderNumber, status, ...changes, updatedBy }` |
| `price:updated` | Base rate changed | `{ baseRate, table, updatedBy, updatedAt }` |
| `product:created` | New product added | Full product object |
| `product:updated` | Product details changed | Full product object |
| `product:deleted` | Product soft-deleted | `{ productId }` |
| `client:new_request` | New client registration request | `{ client }` |
| `client:updated` | Client approval/block status changed | `{ client, action, approvedBy/rejectedBy }` |

#### `chat:new_message`

```json
{
  "_id": "664c...",
  "conversation": "664b...",
  "sender": { "type": "user", "employeeId": null },
  "content": {
    "text": "5.5 wr rate?",
    "mediaType": "none"
  },
  "replyTo": null,
  "waMessageId": "wamid.xxx",
  "deliveryStatus": "delivered",
  "createdAt": "2026-04-06T10:30:00.000Z",
  "conversationId": "664b...",
  "user": { "_id": "664a...", "name": "Vijay", "phone": "917470691408" },
  "displayName": "Vijay Ji Hyderabad Steel",
  "unreadCount": 4
}
```

### 6.2 Client-Side Events

Listen on namespace `/client`:

| Event | Description | Payload |
|-------|-------------|---------|
| `approval:status` | Approval status update | `{ approvalStatus, isProfileComplete, rejectionReason?, message? }` |
| `price:updated` | Prices changed by admin | `{ wrBaseRate, table, updatedAt }` |
| `account:blocked` | Account has been blocked | `{ message }` |

#### `approval:status` (auto-emitted on connect)

```json
{
  "approvalStatus": "approved",
  "isProfileComplete": true,
  "rejectionReason": ""
}
```

Possible `approvalStatus` values: `"pending"`, `"approved"`, `"rejected"`

#### `price:updated`

```json
{
  "wrBaseRate": 41000,
  "table": {
    "wrBaseRate": 41000,
    "wr": [ ... ],
    "hb": [ ... ]
  },
  "updatedAt": "2026-04-06T15:30:00.000Z"
}
```

---

## 7. HTTP Endpoints

Only 4 HTTP endpoints exist. Everything else uses Socket.IO.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/login` | None | Employee login → returns JWT |
| `POST` | `/api/auth/register` | None | Employee registration → returns JWT |
| `GET` | `/api/auth/me` | JWT Bearer | Get current employee profile |
| `GET` | `/webhook` | None | WhatsApp verification handshake |
| `POST` | `/webhook` | None | WhatsApp incoming events (messages, statuses) |
| `GET` | `/health` | None | Health check (returns uptime, status) |

---

## 8. Data Models & Schemas

### Employee
```
{
  _id:          ObjectId
  name:         String (required)
  email:        String (required, unique, lowercase)
  password:     String (required, min 8, excluded from queries by default)
  phone:        String
  role:         "admin" | "manager" | "sales" | "support"
  isActive:     Boolean (default: true)
  lastLoginAt:  Date | null
  createdAt:    Date
  updatedAt:    Date
}
```

### Client
```
{
  _id:              ObjectId
  firebaseUid:      String (required, unique)
  phone:            String (required, unique)
  name:             String
  firmName:         String
  email:            String (lowercase)
  gstNumber:        String (uppercase)
  isProfileComplete: Boolean (default: false)
  approvalStatus:   "pending" | "approved" | "rejected"
  approvedBy:       ObjectId → Employee | null
  approvedAt:       Date | null
  rejectedAt:       Date | null
  rejectionReason:  String
  fcmTokens:        [{ token: String, device: String, updatedAt: Date }]
  isBlocked:        Boolean (default: false)
  lastActiveAt:     Date | null
  createdAt:        Date
  updatedAt:        Date
}
```

### User (WhatsApp user)
```
{
  _id:            ObjectId
  waId:           String (required, unique) — WhatsApp phone number
  name:           String
  phone:          String (required)
  contactName:    String — imported from phone contacts
  partyName:      String — trade/party name
  firmName:       String — company/firm name
  billName:       String — billing name
  gstNo:          String — GST number
  company:        String
  city:           String
  isBlocked:      Boolean (default: false)
  tags:           [String]
  metadata:       Map<String, Mixed>
  lastMessageAt:  Date | null
  createdAt:      Date
  updatedAt:      Date
}
```

### Conversation
```
{
  _id:              ObjectId
  user:             ObjectId → User
  status:           "active" | "closed" | "escalated"
  assignedTo:       ObjectId → Employee | null
  handlerType:      "ai" | "employee"
  employeeTakenAt:  Date | null — when employee took control (auto-resets after 12 hours)
  stage:            String — see stage enum below
  linkedOrder:      ObjectId → Order | null
  context: {
    lastIntent:        String
    pendingAction:     String
    negotiationActive: Boolean
    lastDetectedProduct: {
      category:    String — "wr" | "hb"
      size:        String — WR mm size
      gauge:       String — HB gauge
      mm:          String — HB mm
      carbonType:  String — "normal" | "lc"
      quantity:    Number
      unit:        String — "ton" | "kg" | etc.
    }
    deliveryInquiry:   Boolean
    metadata:          Map<String, Mixed>
  }
  unreadCount:      Number
  lastMessage: {
    text:       String
    senderType: String
    mediaType:  String
    timestamp:  Date
  }
  messageCount:     Number
  lastMessageAt:    Date
  createdAt:        Date
  updatedAt:        Date
}
```

### Message
```
{
  _id:            ObjectId
  conversation:   ObjectId → Conversation
  sender: {
    type:         "user" | "ai" | "employee" | "system"
    employeeId:   ObjectId → Employee | null
  }
  content: {
    text:           String
    mediaType:      "none" | "image" | "document" | "audio" | "video" | "sticker" | "location" | "contact"
    mediaUrl:       String
    mediaLocalPath: String
    waMediaId:      String
    mimeType:       String
    fileName:       String
    fileSize:       Number
    caption:        String
    latitude:       Number | null
    longitude:      Number | null
    locationName:   String
  }
  replyTo:          ObjectId → Message | null
  waMessageId:      String
  waTimestamp:       Date | null
  deliveryStatus:   "pending" | "sent" | "delivered" | "read" | "failed"
  sentAt:           Date | null
  deliveredAt:      Date | null
  readAt:           Date | null
  failedAt:         Date | null
  failureReason:    String
  readByAdmin:      Boolean
  readByAdminAt:    Date | null
  aiMetadata: {
    model:          String
    tokensUsed:     Number
    responseTimeMs: Number
    intent:         String
    detectedAction: String
  }
  isDeleted:        Boolean
  createdAt:        Date
  updatedAt:        Date
}
```

### Order
```
{
  _id:            ObjectId
  orderNumber:    String (auto-generated: "RS-{timestamp}-{random}")
  user:           ObjectId → User
  conversation:   ObjectId → Conversation | null
  items: [{
    product:      ObjectId → Product | null
    category:     "wr" | "hb" | "binding" | "nails"
    productName:  String
    size:         String | null — WR mm
    gauge:        String | null — HB gauge
    mm:           String | null — HB mm
    carbonType:   "normal" | "lc"
    quantity:     Number (min: 0)
    unit:         String (default: "ton")
    unitPrice:    Number
    totalPrice:   Number
  }]
  pricing: {
    subtotal:     Number
    taxAmount:    Number
    freight:      Number
    discount:     Number
    grandTotal:   Number
  }
  advancePayment: {
    amount:       Number
    isPaid:       Boolean
    paidAt:       Date | null
  }
  payments: [{
    amount:       Number
    method:       "cash" | "bank_transfer" | "upi" | "cheque" | "other"
    reference:    String
    note:         String
    receivedAt:   Date
    recordedBy:   ObjectId → Employee
    createdAt:    Date
  }]
  status:         String — see order status enum below
  delivery: {
    driverName:    String
    driverPhone:   String
    vehicleNumber: String
    scheduledDate: Date | null
    dispatchedAt:  Date | null
    deliveredAt:   Date | null
  }
  deliveryAddress: {
    line1:  String
    line2:  String
    city:   String
    state:  String
    pincode: String
  }
  closedAt:       Date | null
  notes:          String
  assignedTo:     ObjectId → Employee | null
  createdBy:      "ai" | "employee"
  createdAt:      Date
  updatedAt:      Date
}
```

### Product
```
{
  _id:          ObjectId
  name:         String (required)
  category:     "wr" | "hb" | "binding" | "nails"
  size:         String (required)
  sizeUnit:     "mm" | "gauge" | "swg"
  carbonType:   "normal" | "lc"
  unit:         "kg" | "ton" | "piece" | "bundle" | "coil"
  isActive:     Boolean
  description:  String
  createdAt:    Date
  updatedAt:    Date
}
```

### BaseRate
```
{
  _id:              ObjectId
  wrBaseRate:       Number (required, min: 0) — WR base rate in ₹/ton
  sizePremiums:     Object — { "5.5": 0, "7": 800, "8": 800, "10": 800, "12": 1200, "14": 1500, "16": 1700, "18": 2200 }
  carbonExtras:     Object — { "normal": 0, "lc": 800 }
  hbPremium:        Number (default: 2500) — added to WR base for HB
  hbGaugePremiums:  Object — per-gauge extra charges for HB wire
  fixedCharge:      Number (default: 345) — added to all prices
  gstPercent:       Number (default: 18) — GST percentage
  isActive:         Boolean — only one active at a time
  updatedBy:        ObjectId → Employee | null
  createdAt:        Date
  updatedAt:        Date
}
```

### Contact
```
{
  _id:          ObjectId
  phone:        String (required) — clean numeric format
  contactName:  String (required)
  syncedBy:     ObjectId → Employee (required)
  createdAt:    Date
  updatedAt:    Date
}
```

---

## 9. Enums & Constants

### Conversation Stages
```
"talking"           — Initial/general conversation
"price_inquiry"     — User is asking about prices
"negotiation"       — Price negotiation in progress
"order_confirmed"   — Order confirmed by user
"advance_pending"   — Waiting for advance payment
"advance_received"  — Advance payment received
"payment_complete"  — Full payment received
"dispatched"        — Material dispatched
"delivered"         — Material delivered
"closed"            — Order/conversation closed
```

### Order Statuses
```
"inquiry"           — Initial inquiry
"quoted"            — Price quoted
"advance_pending"   — Waiting for advance (₹50,000)
"advance_received"  — Advance received
"confirmed"         — Order confirmed
"processing"        — Order being processed
"dispatched"        — Material dispatched
"delivered"         — Material delivered
"cancelled"         — Order cancelled
```

### Employee Roles
```
"admin"    — Full access (approve/reject clients, block, manage everything)
"manager"  — Approve/reject clients, update prices, manage orders
"sales"    — Chat, manage orders, view dashboard
"support"  — Chat, view dashboard
```

### Handler Types
```
"ai"        — AI is responding to messages
"employee"  — Employee has taken control (AI silent for up to 12 hours)
```

### Message Sender Types
```
"user"      — WhatsApp customer
"ai"        — AI-generated response
"employee"  — Employee sent via dashboard
"system"    — System notification
```

### Delivery Status (WhatsApp)
```
"pending"    — Message queued
"sent"       — Sent to WhatsApp
"delivered"  — Delivered to user's phone
"read"       — Read by user (blue ticks)
"failed"     — Delivery failed
```

### Media Types
```
"none"       — Text only
"image"      — Image (JPEG, PNG, etc.)
"document"   — Document (PDF, XLSX, etc.)
"audio"      — Audio message
"video"      — Video
"sticker"    — WhatsApp sticker
"location"   — Location share
"contact"    — Contact card
```

### Payment Methods
```
"cash"           — Cash payment
"bank_transfer"  — Bank/NEFT/RTGS
"upi"            — UPI payment
"cheque"         — Cheque
"other"          — Other method
```

### Product Categories
```
"wr"       — Wire Rod
"hb"       — HB Wire
"binding"  — Binding Wire
"nails"    — Nails
```

### Carbon Types
```
"normal"  — Normal/HC (High Carbon) — default
"lc"      — Low Carbon (costs ₹800 more per ton)
```
Both `wr` and `hb` support `carbonType`. The LC premium (+₹800/ton) is the same for both categories.

### WR Available Sizes (mm)
```
5.5, 7, 8, 10, 12, 14, 16, 18
```

### HB Available Gauges (SWG)
```
1g, 2g, 3g, 4g, 5g, 6g, 7g, 8g, 9g, 10g, 11g, 12g, 13g, 14g, 15g, 16g
1/0, 2/0, 3/0, 4/0, 5/0, 6/0
```

### HB Gauge ↔ MM Range Mapping
```
Gauge   MM Range        Gauge Premium (₹/ton)
──────  ──────────────  ─────────────────────
16g     1.6 - 1.8mm     (check hbGaugePremiums)
15g     1.8 - 2.0mm
14g     2.0 - 2.4mm     +1,700
13g     2.4 - 2.6mm     +1,000
12g     2.4 - 2.8mm     0 (base)
11g     2.8 - 3.0mm     0
10g     3.0 - 3.4mm     0
9g      3.4 - 3.8mm     0
8g      3.8 - 4.2mm     0
7g      4.2 - 4.8mm     0
6g      4.8 - 5.2mm     0
5g      5.2 - 5.6mm     +800
4g      5.6 - 6.2mm     +800
3g      6.2 - 6.8mm     +800
2g      6.8 - 7.2mm     +800
1g      7.2 - 7.8mm     +800
1/0     7.8 - 8.6mm     +800
2/0     8.6 - 9.2mm     +800
3/0     9.2 - 9.6mm     +1,200
4/0     9.6 - 10.2mm    +1,200
5/0     10.2 - 11.0mm   +1,200
6/0     11.0 - 11.8mm   +1,200
```

### Price Calculation Formulas

**WR (Wire Rod):**
```
mergedBase = wrBaseRate + sizePremium[size] + carbonExtra[carbonType]
subtotal   = mergedBase + fixedCharge (345)
gst        = round(subtotal × gstPercent / 100)
total      = subtotal + gst
```

**HB Wire:**
```
hbBase     = wrBaseRate + hbPremium (2500)
mergedBase = hbBase + hbGaugePremium[gauge] + carbonExtra[carbonType]
subtotal   = mergedBase + fixedCharge (345)
gst        = round(subtotal × gstPercent / 100)
total      = subtotal + gst
```
`carbonExtra` uses the same table as WR: `normal = 0`, `lc = 800`.

### Unit Aliases (all mean "ton")
```
ton, tons, tonne, tonnes, mt, mts, m.t., metric ton, metric tons
```

### "dia" / "diameter"
```
Just means mm size (diameter). NOT category-specific.
"5.5 dia" = 5.5mm → WR (available WR size)
"5.3 dia" = 5.3mm → HB (in HB mm range, not a WR size)
"8 dia"   = 8mm   → WR (available WR size)
```

### Order Rules
```
Minimum per item:    2 tons
Minimum total order: 5 tons
Advance payment:     ₹50,000 for booking
Balance:             At time of loading
Transport:           Customer's side
```

---

## Quick Reference: Flutter Socket.IO Setup

```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

// ── Employee App ──
final employeeSocket = IO.io('https://www.radhikasteel.in', <String, dynamic>{
  'transports': ['websocket'],
  'autoConnect': false,
  'auth': {'token': jwtToken},
});
employeeSocket.connect();

// Emit with acknowledgement
employeeSocket.emitWithAck('chat:list', {'page': 1, 'limit': 30}).then((res) {
  if (res['success']) {
    final chats = res['data'] as List;
    final pagination = res['pagination'];
  }
});

// Listen for server events
employeeSocket.on('chat:new_message', (data) {
  // data = { _id, conversation, sender, content, displayName, unreadCount, ... }
});
employeeSocket.on('order:new', (data) { /* new order created */ });
employeeSocket.on('price:updated', (data) { /* price table changed */ });

// ── Client App ──
final clientSocket = IO.io('https://www.radhikasteel.in/client', <String, dynamic>{
  'transports': ['websocket'],
  'autoConnect': false,
  'auth': {'token': firebaseIdToken},
});
clientSocket.connect();

// Listen for approval status (auto-emitted on connect)
clientSocket.on('approval:status', (data) {
  // data = { approvalStatus, isProfileComplete, rejectionReason }
});

// Listen for real-time price updates
clientSocket.on('price:updated', (data) {
  // data = { wrBaseRate, table: { wr: [...], hb: [...] }, updatedAt }
});
```
