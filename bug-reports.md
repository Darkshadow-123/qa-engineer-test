# EU Pay QA Assessment — Bug Reports

This document contains detailed bug reports for all 7 intentional bugs identified in the EU Pay QA test API, along with critical edge cases and security vulnerabilities uncovered during exploratory testing.

---

## Summary of Identified Bugs

| Bug | Title | Component | Severity | Location | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Bug A** | Payment Amount Returned as String Type | Payment API | Medium | `src/routes/payment.routes.js:16, 52` | Reproduced |
| **Bug B** | Missing Maximum Payment Amount Validation | Payment API | High | `src/routes/payment.routes.js:75` | Reproduced |
| **Bug C** | Email Validation Regex Accepts Incomplete Domains | Auth API | Medium | `src/routes/auth.routes.js:12` | Reproduced |
| **Bug D** | Missing Webhook HMAC Signature Verification | Webhooks | Critical | `src/routes/webhook.routes.js:21-33` | Reproduced |
| **Bug E** | Missing Webhook Idempotency Handling | Webhooks | High | `src/routes/webhook.routes.js:38-45, 56` | Reproduced |
| **Bug F** | Duplicate Active Table Orders Permitted | Table Orders | Medium | `src/routes/table-order.routes.js:44-56` | Reproduced |
| **Bug G** | Duplicate E-Invoice Submission Allowed | E-Invoice | Medium | `src/routes/einvoice.routes.js:50-58` | Reproduced |

### Key Ancillary Findings:
- **Security Finding 1 (High):** Unauthenticated Table Order Creation & Negative Totals (`src/routes/table-order.routes.js:32-60`)
- **Security Finding 2 (High):** Missing Signature Verification on E-Invoice Webhook (`src/routes/webhook.routes.js:75-105`)
- **Security Finding 3 (Medium):** Unvalidated Webhook Status & State Machine Inversion (`src/routes/webhook.routes.js:52`)
- **Fixture Defect (Medium):** Seeded Merchant Password Hash Corrupted (`src/db/database.js:19`)
- **Functional Defect (Low):** Email Case Sensitivity During Login (`src/routes/auth.routes.js:83`)

---

## Bug A: Payment Amount Returned as String Instead of Number

**Location:** `src/routes/payment.routes.js` (lines 16 and 52)  
*(Line 16 in `GET /api/payments`, Line 52 in `GET /api/payments/:id`)*  
**Severity:** Medium  
**Component:** Payment API  

### How to Reproduce:

1. Start server: `npm start`
2. Obtain an authenticated merchant session:
   - Register a merchant:
     ```bash
     curl -X POST http://localhost:3000/api/auth/register \
       -H "Content-Type: application/json" \
       -d '{"email":"merchant_a@eupay.test","password":"Password123!","business_name":"Merchant A"}'
     ```
   - Store the returned `token` and `user.id`.
3. Create a payment with a numeric amount:
   ```bash
   curl -X POST http://localhost:3000/api/payments \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <TOKEN>" \
     -d '{"amount":42.50,"currency":"EUR","customer_email":"client@test.com"}'
   ```
   *Observed Response (201 Created):* Returns numeric `amount: 42.5`:
   ```json
   {
     "success": true,
     "message": "Payment created",
     "data": { "id": "3", "amount": 42.5, "currency": "EUR", "status": "pending" }
   }
   ```
4. Query payments list:
   ```bash
   curl -X GET http://localhost:3000/api/payments \
     -H "Authorization: Bearer <TOKEN>"
   ```
5. Query single payment by ID:
   ```bash
   curl -X GET http://localhost:3000/api/payments/3 \
     -H "Authorization: Bearer <TOKEN>"
   ```

### Expected Behavior:
The `amount` property in responses from both `GET /api/payments` and `GET /api/payments/:id` must be of type `number` (e.g., `42.5` or `25.5`), consistent with the `POST /api/payments` endpoint contract and the database storage type.

### Actual Behavior:
Both `GET /api/payments` and `GET /api/payments/:id` return `amount` serialized as a string:
```json
{
  "success": true,
  "data": [
    {
      "id": "3",
      "amount": "42.5",
      "currency": "EUR",
      "status": "pending",
      "customer_email": "client@test.com",
      "created_at": "2026-10-11T07:46:00.000Z"
    }
  ],
  "count": 1
}
```
In JavaScript: `typeof data.data[0].amount === "string"`.

### Impact:
- **Client Calculation Failures:** Frontend applications performing calculations or formatting currency receive string primitives. In JavaScript, `"42.5" + 10` evaluates to `"42.510"` instead of `52.5`, causing balance, tax, and display errors.
- **Contract Inconsistency:** `POST /api/payments` returns numeric `amount`, but subsequent `GET` requests return strings, creating an inconsistent API contract across related endpoints.

### Root Cause:
In `src/routes/payment.routes.js`, `p.amount` (which is already stored as a numeric primitive in `db.payments`) is explicitly converted to a string in two places:
- Line 16 (`GET /api/payments`): `amount: p.amount.toString()`
- Line 52 (`GET /api/payments/:id`): `amount: payment.amount.toString()`

### Suggested Fix:
Simply remove `.toString()` from both mapping functions and pass the stored numeric property directly:
```javascript
// src/routes/payment.routes.js line 16
amount: p.amount,

// src/routes/payment.routes.js line 52
amount: payment.amount,
```

---

## Bug B: Missing Maximum Payment Amount Validation

**Location:** `src/routes/payment.routes.js` (line 75)  
**Severity:** High  
**Component:** Payment API  

### How to Reproduce:

1. Obtain a valid merchant JWT token.
2. Submit a payment request with an excessively large transaction amount (€999,999,999):
   ```bash
   curl -X POST http://localhost:3000/api/payments \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <TOKEN>" \
     -d '{"amount":999999999,"currency":"EUR","customer_email":"billionaire@test.com"}'
   ```
3. Test boundary amounts above the standard limit of €50,000 (e.g., `50000.01`):
   ```bash
   curl -X POST http://localhost:3000/api/payments \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <TOKEN>" \
     -d '{"amount":50000.01,"currency":"EUR","customer_email":"overlimit@test.com"}'
   ```
4. Test edge cases and input sanitization boundaries:
   - Scientific notation string: `"1e9"` (parsed by `parseFloat` as `1000000000` and accepted)
   - Hexadecimal string: `"0x10"` (`Number("0x10") === 16`, which passes naive numeric checks if strings are coerced)
   - Boolean value `true`: `!amount` is false, `isNaN(true)` is false in JS (`Number(true) === 1`), but `parseFloat(true)` yields `NaN`, resulting in `amount: null` stored in DB
   - Decimal precision: `10.999` (fractional cents accepted without validation)
   - Note on `"10abc"`: Already rejected by existing `isNaN("10abc") === true`, but serves as a regression check against naive `parseFloat` fixes

### Expected Behavior:
The API must enforce a business transaction limit (maximum €50,000 per payment). Any payment exceeding €50,000 must be rejected with HTTP `400 Bad Request` and an error message containing `"maximum"`. Additionally, boolean values, non-decimal strings (hex, scientific notation), and fractional currency units (`10.999`) must be rejected, while valid small decimals (such as `0.07` and `1.15`) must be accepted.

### Actual Behavior:
The server accepts any amount regardless of magnitude, returning HTTP `201 Created`:
```json
{
  "success": true,
  "message": "Payment created",
  "data": {
    "id": "4",
    "amount": 999999999,
    "currency": "EUR",
    "status": "pending",
    "customer_email": "billionaire@test.com"
  }
}
```
Boundary amounts like `50000.01` and fractional cents `10.999` are also stored in the database.

### Impact:
- **Business Risk & Financial Exposure:** Without a transaction ceiling, unvetted high-value transactions pass through the gateway, increasing chargeback exposure and operational liability.
- **Float Precision & Ledger Corruption:** Excessively large integers lose precision in standard JavaScript IEEE 754 floating point arithmetic, causing reconciliation discrepancies.

### Root Cause:
In `src/routes/payment.routes.js`, line 71 only checks:
```javascript
if (!amount || isNaN(amount) || amount <= 0) {
  return res.status(400).json({ error: 'Valid amount is required' });
}
```
There is no upper-bound validation (`amount > 50000`), no boolean guard, and no currency decimal precision validation.

### Suggested Fix:
Define a named constant `MAX_PAYMENT_AMOUNT = 50000` and validate using decimal-safe formatting and upper bounds:
```javascript
const MAX_PAYMENT_AMOUNT = 50000;

// Reject booleans, null/undefined, and types other than number or numeric string
if (amount === undefined || amount === null || typeof amount === 'boolean') {
  return res.status(400).json({ error: 'Valid amount is required' });
}

// Ensure amount matches standard currency decimal format (e.g. 50, 0.07, 1.15, max 2 decimals)
// Rejects hex ("0x10"), scientific ("1e9"), negative, or fractional cents ("10.999")
const strAmount = String(amount).trim();
if (!/^\d+(\.\d{1,2})?$/.test(strAmount)) {
  return res.status(400).json({ error: 'Valid amount is required (maximum 2 decimal places)' });
}

const numAmount = Number(strAmount);
if (!Number.isFinite(numAmount) || numAmount <= 0) {
  return res.status(400).json({ error: 'Valid amount is required' });
}

// Enforce maximum transaction ceiling
if (numAmount > MAX_PAYMENT_AMOUNT) {
  return res.status(400).json({ 
    error: `Payment amount exceeds maximum limit of €${MAX_PAYMENT_AMOUNT}` 
  });
}
```

---

## Bug C: Email Validation Regex Accepts Incomplete Domain Without TLD

**Location:** `src/routes/auth.routes.js` (line 12)  
**Severity:** Medium  
**Component:** Auth API  

### How to Reproduce:

1. Submit a registration request with an email missing a top-level domain (`user@domain`):
   ```bash
   curl -X POST http://localhost:3000/api/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email":"invaliduser@domain","password":"Password123!","business_name":"Acme Corp"}'
   ```
2. Submit registrations with other invalid domain formats:
   - `user@domain.` (trailing dot)
   - `user@.com` (missing domain label)
   - `user@domain..com` (consecutive dots)
   - `user@-domain.com` (domain label starting with hyphen)

### Expected Behavior:
Registration must fail with HTTP `400 Bad Request` and error `"Invalid email format"` when the domain lacks a valid label structure or a Top-Level Domain (TLD) of at least 2 alphabetic characters.

### Actual Behavior:
Registration succeeds with HTTP `201 Created`:
```json
{
  "message": "Registration successful",
  "user": {
    "id": "4",
    "email": "invaliduser@domain",
    "business_name": "Acme Corp"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Impact:
- **Undeliverable System Communications:** Merchants register invalid emails that cannot receive automated receipts, notifications, or password reset tokens.
- **Database Pollution:** Non-deliverable identity records accumulate in the database.

### Root Cause:
In `src/routes/auth.routes.js`, line 12:
```javascript
function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+$/;
  return emailRegex.test(email);
}
```
The regex only verifies the presence of an `@` with non-whitespace characters on either side. It does not enforce domain labels, dots, or a TLD.

### Suggested Fix:
Replace the regex with a strict pattern that requires valid domain labels separated by single dots and a 2+ character TLD:
```javascript
function validateEmail(email) {
  if (typeof email !== 'string') return false;
  // Validates standard email format: requires valid local-part, structured domain labels, and 2+ char TLD
  const emailRegex = /^[a-zA-Z0-9._%+-]+@([a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}$/;
  return emailRegex.test(email.trim());
}
```
*(Note: While the domain part is now strictly enforced, further RFC edge cases in the local part—such as leading or consecutive dots like `..a@domain.com`—can be handled by dedicated validation libraries like `validator.js` in production).*

---

## Bug D: Missing Webhook HMAC Signature Verification

**Location:** `src/routes/webhook.routes.js` (lines 21-33)  
**Severity:** Critical  
**Component:** Webhooks  

### How to Reproduce:

1. Identify an existing payment in `"pending"` status (e.g. payment `id: "2"`).
2. Send a forged status webhook request with an invalid signature (or omit the header entirely):
   ```bash
   curl -X POST http://localhost:3000/api/webhooks/payment-status \
     -H "Content-Type: application/json" \
     -H "x-webhook-signature: fake-unauthorized-signature-12345" \
     -d '{"payment_id":"2","status":"completed","event_id":"evt_fraud_001"}'
   ```
3. Query `GET /api/payments/2`.

### Expected Behavior:
The webhook endpoint must verify that incoming status notifications originate from the legitimate payment provider (e.g. Powens). If the `x-webhook-signature` header is missing or does not match the HMAC-SHA256 signature calculated with `WEBHOOK_SECRET`, the request must be rejected with HTTP `401 Unauthorized` (`"Invalid signature"` or `"Webhook signature required"`).

### Actual Behavior:
The signature header is completely ignored, and the payment status is updated to `"completed"` with HTTP `200 OK`:
```json
{
  "success": true,
  "message": "Webhook processed",
  "payment_id": "2",
  "new_status": "completed"
}
```

### Impact:
- **Severe Financial Vulnerability:** Any anonymous caller can mark pending payments as `"completed"` without authorization, leading to premature release of merchandise or services.
- **Unauthorized State Manipulation:** Attackers can tamper with the payment state machine (e.g. marking payments `"refunded"`).

### Root Cause:
In `src/routes/webhook.routes.js`, lines 21-33, the HMAC signature verification block is commented out:
```javascript
// BUG D: No signature verification
// const expectedSignature = crypto
//   .createHmac('sha256', WEBHOOK_SECRET)
//   .update(JSON.stringify(req.body))
//   .digest('hex');
// 
// if (signature !== expectedSignature) {
//   return res.status(401).json({ error: 'Invalid signature' });
// }
```

### Suggested Fix:
Enforce signature presence and verify using `crypto.timingSafeEqual` to prevent timing attacks.
*(Architecture Note: In production systems, payment providers compute HMAC over raw byte streams rather than `JSON.stringify(req.body)`. In this codebase, body-parser already parses the body, so we mirror the commented signature logic while recommending `express.json({ verify: ... })` for production raw body hashing).*

```javascript
const signature = req.headers['x-webhook-signature'];
if (!signature) {
  return res.status(401).json({ error: 'Webhook signature required' });
}

const expectedSignature = crypto
  .createHmac('sha256', process.env.WEBHOOK_SECRET || WEBHOOK_SECRET)
  .update(JSON.stringify(req.body))
  .digest('hex');

const sigBuffer = Buffer.from(signature, 'hex');
const expectedBuffer = Buffer.from(expectedSignature, 'hex');

if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
  return res.status(401).json({ error: 'Invalid signature' });
}
```

---

## Bug E: Missing Webhook Idempotency Handling

**Location:** `src/routes/webhook.routes.js` (lines 38-45, 56)  
**Severity:** High  
**Component:** Webhooks  

### How to Reproduce:

1. Send an initial payment webhook with event ID `evt_unique_101`:
   ```bash
   curl -X POST http://localhost:3000/api/webhooks/payment-status \
     -H "Content-Type: application/json" \
     -d '{"payment_id":"1","status":"completed","event_id":"evt_unique_101"}'
   ```
   *Observed Response:* `200 OK` (`"Webhook processed"`).
2. Immediately replay the exact same webhook request with the same `event_id`:
   ```bash
   curl -X POST http://localhost:3000/api/webhooks/payment-status \
     -H "Content-Type: application/json" \
     -d '{"payment_id":"1","status":"refunded","event_id":"evt_unique_101"}'
   ```

### Expected Behavior:
Payment gateways periodically retransmit webhooks due to network timeouts. The endpoint must be idempotent: upon receiving an already-processed `event_id`, it should immediately acknowledge receipt with HTTP `200 OK` and `{ "message": "Already processed" }` without re-executing state updates or modifying timestamps.

### Actual Behavior:
The replayed webhook executes again, overwriting the payment status to `"refunded"` and resetting `payment.webhook_received_at`:
```json
{
  "success": true,
  "message": "Webhook processed",
  "payment_id": "1",
  "new_status": "refunded"
}
```

### Impact:
- **Redundant Side Effects:** Replayed webhooks cause repeated status changes, conflicting database writes, and repeated webhook notifications.
- **Status Machine Inversion:** An out-of-order replay can revert a finalized status back to an earlier state.

### Root Cause:
In `src/routes/webhook.routes.js`, the check against `db.processed_webhooks` and the subsequent record push are commented out (lines 38-45 and line 56).

### Suggested Fix:
Validate `event_id`, check `db.processed_webhooks` atomically before executing updates, and record `event_id` upon successful payment update:
```javascript
if (!event_id) {
  return res.status(400).json({ error: 'event_id required' });
}

if (!db.processed_webhooks) db.processed_webhooks = [];
if (db.processed_webhooks.includes(event_id)) {
  return res.status(200).json({ 
    success: true, 
    message: 'Already processed',
    event_id 
  });
}

const payment = getPaymentById(payment_id);
if (!payment) {
  return res.status(404).json({ error: 'Payment not found' });
}

payment.status = status;
payment.webhook_received_at = new Date();
db.processed_webhooks.push(event_id);
```

---

## Bug F: Missing Duplicate Active Table Order Prevention

**Location:** `src/routes/table-order.routes.js` (lines 44-56)  
**Severity:** Medium  
**Component:** Table Orders  

### How to Reproduce:

1. Submit a table order for Table 12:
   ```bash
   curl -X POST http://localhost:3000/api/table-orders \
     -H "Content-Type: application/json" \
     -d '{"merchant_id":"1","table_number":12,"items":[{"name":"Burger","price":15,"quantity":2}]}'
   ```
   *Observed:* Order created with status `"pending"`.
2. Submit a second order for the same table while the first order remains active:
   ```bash
   curl -X POST http://localhost:3000/api/table-orders \
     -H "Content-Type: application/json" \
     -d '{"merchant_id":"1","table_number":"12","items":[{"name":"Fries","price":5,"quantity":1}]}'
   ```

### Expected Behavior:
A physical table should not have conflicting active orders. If a table currently has an order in an active status (`pending`, `confirmed`, or `preparing`), subsequent order creation requests must be rejected with HTTP `409 Conflict` (`"Table already has an active order"`).

### Actual Behavior:
Both requests succeed with HTTP `201 Created`, generating duplicate active order records for Table 12.

### Impact:
- **Kitchen Duplication & Food Waste:** Kitchen displays receive multiple conflicting orders for the same physical table, resulting in duplicate food preparation and food waste.
- **POS & Billing Discrepancies:** Waiting staff face confused bills at checkout when multiple concurrent active tabs exist for a single table.

### Root Cause:
In `src/routes/table-order.routes.js`, lines 44-56:
```javascript
// BUG F: No duplicate order prevention
// const existingOrder = (db.table_orders || []).find(
//   o => o.merchant_id === merchant_id && 
//        o.table_number === table_number && 
//        o.status === 'pending'
// );
// if (existingOrder) {
//   return res.status(409).json({ error: 'Table already has a pending order' });
// }
```
The check is commented out. Furthermore, the commented snippet used strict `===` on `merchant_id` and `table_number` (failing when string `"12"` is compared to number `12`, or `"1"` to `1`), and only checked `status === 'pending'`.

### Suggested Fix:
Check for active orders normalizing both `merchant_id` and `table_number` across active statuses:
```javascript
const activeStatuses = ['pending', 'confirmed', 'preparing'];
const existingOrder = (db.table_orders || []).find(
  o => String(o.merchant_id) === String(merchant_id) &&
       String(o.table_number) === String(table_number) &&
       activeStatuses.includes(o.status)
);

if (existingOrder) {
  return res.status(409).json({ error: 'Table already has an active order' });
}
```

---

## Bug G: Missing Duplicate E-Invoice Submission Prevention

**Location:** `src/routes/einvoice.routes.js` (lines 50-58)  
**Severity:** Medium  
**Component:** E-Invoicing  

### How to Reproduce:

1. Obtain a valid merchant JWT token.
2. Submit an e-invoice to the tax authority simulator (Seqino PDP):
   ```bash
   curl -X POST http://localhost:3000/api/einvoice/submit \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <TOKEN>" \
     -d '{"invoice_id":"inv_9001","customer_siret":"12345678901234"}'
   ```
   *Observed Response (200 OK):* Returns `submission_id: "SUB-fc041c5a..."` and `status: "submitted"`.
3. Re-submit the identical invoice:
   ```bash
   curl -X POST http://localhost:3000/api/einvoice/submit \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <TOKEN>" \
     -d '{"invoice_id":"inv_9001","customer_siret":"12345678901234"}'
   ```

### Expected Behavior:
Per the assignment's PDP specification, an invoice may only be submitted once. Resubmitting an invoice that has already been submitted or accepted (`einvoice_status === 'submitted' || einvoice_status === 'accepted'`) must return HTTP `409 Conflict` (`"Invoice already submitted to tax authority"`).

### Actual Behavior:
The API allows repeated submissions, generating a brand new `submission_id` (`"SUB-ca60bb61..."`) and overwriting the existing filing metadata:
```json
{
  "success": true,
  "message": "Invoice submitted to tax authority",
  "data": {
    "invoice_id": "inv_9001",
    "submission_id": "SUB-ca60bb61-20e1-4be9-b85a-6585f85059f5",
    "status": "submitted",
    "submitted_at": "2026-10-11T07:46:20.000Z"
  }
}
```

### Impact:
- **Tax Platform Desynchronization:** Multiple conflicting submission IDs are issued for the same invoice, leading to duplicate submission errors on the partner PDP platform.
- **Audit Trail Loss:** Overwriting the submission ID erases the original filing timestamp and trace history.

### Root Cause:
In `src/routes/einvoice.routes.js`, lines 50-58:
```javascript
// BUG G: No duplicate submission check
// if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
//   return res.status(409).json({ 
//     error: 'Invoice already submitted to tax authority' 
//   });
// }
```

### Suggested Fix:
Enforce the status check after ownership verification:
```javascript
if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
  return res.status(409).json({ 
    error: 'Invoice already submitted to tax authority' 
  });
}
```

---

## Promoted Ancillary Security & Functional Findings

### Security Finding 1: Unauthenticated Table Order Creation & Negative Totals
- **Location:** `src/routes/table-order.routes.js` (lines 32-60)
- **Severity:** High
- **How to Reproduce:**
  Submit an unauthenticated order with negative prices:
  ```bash
  curl -X POST http://localhost:3000/api/table-orders \
    -H "Content-Type: application/json" \
    -d '{"merchant_id":"1","table_number":99,"items":[{"name":"Discount","price":-50,"quantity":1},{"name":"Item","price":10,"quantity":-2}]}'
  ```
- **Observed Behavior:**
  Returns `201 Created` with `total: -70` (`(-50 * 1) + (10 * -2) = -70`).
- **Impact:**
  1. No authentication middleware is applied on `POST /api/table-orders`, allowing any unauthenticated client to create orders for any `merchant_id`.
  2. Input price and quantity are not checked for positive bounds, creating negative or `NaN` totals.
  3. Real-time Socket.IO emission (`new_order`) is commented out.

### Security Finding 2: Missing Signature Verification on E-Invoice Webhook
- **Location:** `src/routes/webhook.routes.js` (lines 75-105)
- **Severity:** High
- **Detail:** While `payment-status` has commented-out signature code, `POST /api/webhooks/e-invoice` has no signature check at all. Anyone can forge a tax authority webhook call to update `einvoice_status` to `"rejected"` or `"accepted"`.

### Security Finding 3: Unvalidated Webhook Status & State Machine Inversion
- **Location:** `src/routes/webhook.routes.js` (line 52)
- **Severity:** Medium
- **Detail:** In `POST /api/webhooks/payment-status`, `payment.status` is directly assigned from `req.body.status` without checking against allowed lifecycle statuses (`['pending', 'processing', 'completed', 'failed', 'refunded']`). This allows status regression (e.g. flipping a `completed` transaction back to `pending`) or injection of arbitrary strings.

### Fixture Defect: Corrupted Seeded Merchant Password Hash
- **Location:** `src/db/database.js` (line 19)
- **Severity:** Medium
- **Detail:** The seeded hash `$2a$10$8Z3KxGXvGqJQZ.ZF9Z3KxGXvGqJQZ.ZF9Z3KxGXvGqJQZ.ZF9` contains a visibly repeating pattern. Calling `POST /api/auth/login` with `{"email":"merchant@test.com","password":"Test123!"}` returns `401 Invalid credentials` because `bcrypt.compare("Test123!", hash)` returns `false`.
- **Recommendation:** Replace the corrupted hash in `database.js` with a valid bcrypt hash generated via `bcrypt.hashSync('Test123!', 10)`.

### Functional Defect: Email Case Sensitivity on Login
- **Location:** `src/routes/auth.routes.js` (line 83)
- **Severity:** Low
- **Observed Behavior:**
  - Register with: `CaseTest_1791704813217@domain.com` -> `201 Created`
  - Login with: `casetest_1791704813217@domain.com` -> `401 Invalid credentials`
- **Detail:** `findUserByEmail` uses strict equality (`u.email === email`). In industry standard practice across major email providers, email lookups are treated as case-insensitive. User emails should be normalized using `.toLowerCase().trim()`.

### Functional Defect: Catch-All Error Handler Returns 500 for Malformed Client JSON
- **Location:** `src/server.js` (lines 105-108)
- **Severity:** Low to Medium
- **Component:** Server Middleware
- **How to Reproduce:**
  Send a POST request with broken or malformed JSON to any endpoint with JSON parsing (e.g. `POST /api/webhooks/payment-status` or `POST /api/payments`):
  ```bash
  curl -X POST http://localhost:3000/api/webhooks/payment-status \
    -H "Content-Type: application/json" \
    -d '{"invalid_json": '
  ```
- **Observed Behavior:**
  Returns HTTP `500 Internal Server Error` with response body `{"error": "Something went wrong!"}`.
- **Expected Behavior:**
  A client payload syntax error is a client-side defect that should be rejected with HTTP `400 Bad Request`. `express.json()` / `body-parser` attaches `status: 400` / `statusCode: 400` to the raised `SyntaxError`. The application error-handling middleware should respect `err.status` / `err.statusCode` rather than categorizing client formatting errors as unhandled internal server failures.
- **Impact:**
  - **Monitoring Pollution:** Emitting 5xx HTTP codes for invalid client requests inflates error-budget consumption and triggers unnecessary on-call pager alerts.
  - **Obscured Diagnostics:** API clients receive a generic server crash message rather than clear feedback that their JSON payload was malformed.
- **Suggested Fix:**
  Update the catch-all error handler in `src/server.js` (lines 106-109) to honor `err.status` or `err.statusCode`:
  ```javascript
  app.use((err, req, res, next) => {
    console.error(err.stack);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
      error: status === 400 ? 'Invalid JSON payload' : 'Something went wrong!'
    });
  });
  ```

