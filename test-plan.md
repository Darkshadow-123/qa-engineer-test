# EU Pay — Webhook Payment Flow Test Plan

## Document Information
- **Target Component:** Payment Status Webhook Integration (`POST /api/webhooks/payment-status`)
- **Version:** 1.0.0
- **Author:** QA Engineering
- **Date:** October 2026

---

## 1. Test Scope

### 1.1 In Scope
- **End-to-End Payment Status Webhook Flow:** Processing incoming notifications from external payment providers (e.g. Powens, Bridge, Stripe) to update merchant transaction statuses.
- **Security & Authenticity:** HMAC-SHA256 signature verification, timing attack resilience, secret key isolation, and injection attacks.
- **Idempotency & Concurrency:** Event deduplication, concurrent webhook processing, out-of-order delivery, and retransmission handling.
- **Data Integrity & State Transitions:** Valid status progressions (`pending` → `processing` → `completed`), non-existent payment handling, and persistence verification.
- **Real-Time Integration:** Real-time event notifications via Socket.IO rooms (`merchant_${merchantId}`).

### 1.2 Out of Scope
- Merchant Portal UI/UX (tested via automated browser suites separately).
- Payment provider external banking Rails/SEPA network latency.
- Extreme load/stress testing beyond gateway burst profiles (> 5,000 req/sec handled by infrastructure team).

---

## 2. Test Environment

| Component | Specification |
| :--- | :--- |
| **API Runtime** | Node.js 20+ (Express 4.18, Socket.IO 4.7) |
| **Test Runners** | Node.js native test runner (`node:test`, `node:assert`) |
| **Environment URLs** | Local API server (`http://localhost:3000`) & Isolated test instances (`http://localhost:3101`–`3105`) |
| **Database** | In-memory transactional test store (`db.payments`, `db.processed_webhooks`), reset per suite lifecycle |
| **Webhook Simulator** | Automated test suite (`helpers.js` + `crypto`), curl, and Postman (`postman-collection.json`) |
| **Secrets Configuration** | HMAC secret injected via `process.env.WEBHOOK_SECRET` |

---

## 3. Test Scenarios (14 Scenarios)

| ID | Title | Priority | Preconditions | Input / Steps | Expected Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **TS-01** | Valid Webhook Processing | P0 | Payment `id: "2"` exists in `pending` status | `POST /payment-status` with valid payload, `event_id: "evt_01"`, and valid HMAC-SHA256 signature header | HTTP 200 OK; `new_status: "completed"`; `db.payments["2"].status` becomes `"completed"`; `webhook_received_at` recorded |
| **TS-02** | Invalid Signature Rejection | P0 | Payment exists | Send payload with forged `x-webhook-signature: "invalid-hex-sig"` | HTTP 401 Unauthorized; `{ error: "Invalid signature" }`; payment status remains unchanged |
| **TS-03** | Missing Signature Header | P0 | Payment exists | Send payload with omitted `x-webhook-signature` header | HTTP 401 Unauthorized; `{ error: "Webhook signature required" }`; no database mutation |
| **TS-04** | Duplicate Webhook Idempotency | P0 | Webhook with `event_id: "evt_02"` already processed | Send identical webhook with `event_id: "evt_02"` and status `"refunded"` | HTTP 200 OK; `{ success: true, message: "Already processed" }`; payment status remains unchanged (`"completed"`) |
| **TS-05** | Non-Existent Payment ID | P1 | No payment exists with `id: "99999"` | Send valid signed webhook for `payment_id: "99999"` | HTTP 404 Not Found; `{ error: "Payment not found" }`; event ID is NOT added to processed list |
| **TS-06** | Out-of-Order Webhook (Webhook Before Payment) | P1 | Payment creation in flight | 1. Send webhook for `payment_id: "100"` → 404.<br>2. Create payment `"100"`.<br>3. Gateway retries webhook with same `event_id` | Initial attempt returns 404; subsequent retry returns 200 OK and marks payment completed without idempotency lock-out |
| **TS-07** | Multiple Webhooks (Status Progression & State Machine) | P1 | Payment in `pending` status | 1. Send valid progression (`pending` → `processing` → `completed`).<br>2. Attempt invalid regression (`completed` → `pending`) | Valid progression returns 200 OK. Invalid reverse transition is expected to fail today (server permits arbitrary status regression without lifecycle guards; tracked as known finding: Security Finding 3 in bug-reports.md) |
| **TS-08** | Missing Required Payload Fields | P1 | Valid signature | Send body missing `payment_id`, `status`, or `event_id` | HTTP 400 Bad Request; descriptive validation error |
| **TS-09** | Malformed JSON Payload | P1 | Server running | Send invalid JSON body (e.g. `{"payment_id": `) with header `Content-Type: application/json` | Currently 500 Internal Server Error (see Functional Defect in bug-reports.md: catch-all error handler masks body-parser 400 SyntaxError); desired: 400 Bad Request |
| **TS-10** | Concurrent Duplicate Webhooks (Race Condition) | P0 | Payment in `pending` status | Fire 5 parallel asynchronous HTTP POST requests with identical `event_id` via `Promise.all` | Exactly 1 request receives `"Webhook processed"`; remaining 4 receive `"Already processed"`; no duplicate writes |
| **TS-11** | SQL/NoSQL Injection in `payment_id` | P0 | Valid signature | Send `payment_id: "1' OR '1'='1'"` or `{"$gt": ""}` | Returns 404 Not Found on in-memory store. Strict input schema validation (rejecting non-alphanumeric IDs with 400) is expected to fail today, tracked as a known finding |
| **TS-12** | Signature Timing Attack Resilience | P0 | Valid signature generated | 1. Send valid signature with 2 appended junk bytes (`+ "zz"`).<br>2. Send single-character wrong signature | HTTP 401 Unauthorized; length checks and `crypto.timingSafeEqual` prevent early termination side-channel leaks |
| **TS-13** | Webhook Replay Attack with State Mutation | P0 | Payment `completed` via `event_id: "evt_final"` | Attacker captures and resends `evt_final` attempting to flip status to `pending` | HTTP 200 OK (`"Already processed"`); status remains locked in `completed` |
| **TS-14** | XSS and Script Injection in Status | P1 | Valid signature | Send `status: "<script>alert(1)</script>"` | Desired: HTTP 400 (rejected by status whitelist/sanitization). Expected to fail today (server currently accepts and persists arbitrary status strings; tracked as known finding: Security Finding 3 in bug-reports.md) |

---

## 4. Security Testing Strategy

### 4.1 HMAC-SHA256 Verification & Raw Body Handling
- **Raw Byte Verification:** Ensure HMAC calculation uses the raw incoming HTTP request buffer (`req.rawBody`) rather than re-serialized JSON, preventing key reordering or whitespace mismatch false-positives.
- **Timing Safe Equality:** Constant-time comparison must be enforced via `crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))`. A prior buffer length check (`provided.length === expected.length`) must be performed to avoid exceptions.
- **Hex Decoding Vulnerability Prevention:** Pass raw UTF-8 string buffers into comparison rather than `Buffer.from(sig, 'hex')` to ensure invalid trailing characters are not silently truncated.

### 4.2 Replay & State Machine Security
- All incoming webhooks must mandate a unique `event_id`.
- Processed event IDs must be indexed and checked atomically prior to executing state transitions.
- Once a payment reaches a terminal state (`completed`, `cancelled`, `refunded`), transitions back to non-terminal states (`pending`) must be rejected by business rules.

### 4.3 Input Sanitization & Injection Prevention
- `payment_id` and `status` inputs must be constrained to expected alphanumeric formats.
- JSON body sizes must be capped (`express.json({ limit: '100kb' })`) to prevent Denial of Service via massive payloads.

---

## 5. Edge Cases & Boundary Analysis

1. **Extreme `payment_id` formats:** Testing GUIDs, 64-bit integer strings, and negative values.
2. **Special Characters & Unicode:** Handling multi-byte characters and international status text without encoding corruption.
3. **Null / Boolean / Empty `event_id`:** Guarding against falsy bypasses (`event_id: null`, `event_id: ""`, `event_id: false`).
4. **Clock Skew & Future Timestamps:** Verifying timestamps recorded in `payment.webhook_received_at` reflect the server's monotonic clock rather than unverified client headers.
5. **Zero-Length Body:** Requests with empty bodies or `Content-Length: 0` must return HTTP 400 without crashing the event loop.

---

## 6. Integration & Real-Time Testing

### 6.1 Database Persistence
- Verify that every successful webhook updates:
  1. `payment.status` = requested status
  2. `payment.webhook_received_at` = valid ISO Date instance
  3. `db.processed_webhooks` includes `event_id`

### 6.2 Socket.IO Event Propagation
- **Target Room:** `merchant_${merchant_id}`
- **Event:** `order_status_changed` / `payment_status_updated`
- **Validation:** When a webhook transitions a payment, the Socket.IO server must emit an update payload `{ payment_id, status }` to subscribed merchant clients within 100ms.

### 6.3 Gateway Retry Logic Verification
- If an endpoint returns 5xx or network timeout, external gateways retry with exponential backoff (e.g., at 1m, 5m, 15m, 1h). The system must tolerate retransmissions seamlessly without state corruption.

---

## 7. Production Risk Assessment & Mitigation

| Risk Description | Severity | Probability | Detection Strategy | Mitigation Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **Forged Webhook / Premature Goods Release** | Critical | High | Metric alert on `webhook_auth_failures_total` spike; audit log mismatch | Enforce HMAC-SHA256 signature verification with rotated secrets stored in AWS Secrets Manager / KMS |
| **Duplicate Fulfillment from Gateway Retransmission** | High | High | Metric alert on duplicate event volume; accounting ledger discrepancies | Atomic idempotency checking with Redis distributed key locks (`SET NX EX 86400`) |
| **Out-of-Order Webhook Delivery (Race Condition)** | High | Medium | Order state machine error logs; status regression alerts | Version/timestamp tracking per payment (`payment.version`); reject status updates with older timestamps |
| **Webhook Processing Latency Spikes (Event Loop Blocking)** | Medium | Low | APM p99 latency alerts (`http_request_duration_ms > 500ms`) | Offload long-running side effects (emails, accounting, e-invoices) to background workers via AWS SQS / BullMQ |
| **In-Memory Store Data Loss on Server Restart** | High | High (local dev) | Container restart health checks | Migrate from in-memory dictionary to persistent PostgreSQL database with transactional ACID guarantees |
