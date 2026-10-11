# EU Pay QA Assessment: Bug Fixes

All seven intentional bugs (A to G) are fixed. Two supporting changes were also needed to verify them: raw-body capture for webhook signatures, and a working seeded login. No endpoint paths, request shapes or success-response shapes were changed.

Every fix was verified by running the server and sending real requests; observed results are listed under **Testing** in each fix. `npm run verify-bugs` (a static scan for the original bug patterns) now reports 0/7 bugs present.

| Fix | Bug | Files | Outcome |
| :--- | :--- | :--- | :--- |
| 1 | A: amount returned as string | `payment.routes.js` | Numeric `amount` from list and detail endpoints |
| 2 | B: no maximum amount | `payment.routes.js` | 400 above 50,000; strict 2-decimal validation |
| 3 | C: email accepts `user@domain` | `auth.routes.js` | 400 for incomplete domains |
| 4 | D: no webhook signature check | `webhook.routes.js`, `server.js` | 401 for missing or invalid signature |
| 5 | E: webhook not idempotent | `webhook.routes.js` | Duplicate events acknowledged, not re-applied |
| 6 | F: duplicate table orders | `table-order.routes.js` | 409 while the table has an active order |
| 7 | G: duplicate e-invoice submission | `einvoice.routes.js` | 409 on resubmission |
| 8 | Fixture: seeded login broken | `database.js` | `merchant@test.com` / `Test123!` now works |

---

## Fix 1: Payment Amount Data Type (Bug A)

**Bug:** `GET /api/payments` and `GET /api/payments/:id` returned `amount` as a string, while `POST /api/payments` returned a number.

**Files Changed:** `src/routes/payment.routes.js` (list mapping and single-payment response)

**Code Changes:** (the two constants at the top of the first hunk belong to Fix 2)
```diff
--- a/src/routes/payment.routes.js
+++ b/src/routes/payment.routes.js
@@ -4,16 +4,21 @@
 
 const router = express.Router();
 
+// Business rule: maximum value of a single payment, in the payment currency
+const MAX_PAYMENT_AMOUNT = 50000;
+// Plain decimal with at most 2 fractional digits (rejects hex, scientific notation, negatives, fractional cents)
+const AMOUNT_FORMAT = /^\d+(\.\d{1,2})?$/;
+
 // GET /api/payments - List all payments for authenticated merchant
 router.get('/', authenticate, (req, res) => {
   try {
     const merchantId = req.user.id;
     const payments = getPayments(merchantId);
 
-    // BUG A: Amount is being converted to string instead of remaining as number
+    // FIX (Bug A): amount is stored as a number and must be returned as a number
     const formattedPayments = payments.map(p => ({
       id: p.id,
-      amount: p.amount.toString(), // ← BUG: Should be number, not string
+      amount: p.amount,
       currency: p.currency,
       status: p.status,
       customer_email: p.customer_email,
@@ -49,7 +54,7 @@
       success: true,
       data: {
         id: payment.id,
-        amount: payment.amount.toString(), // Same bug as above
+        amount: payment.amount, // FIX (Bug A): keep numeric type, consistent with POST response
         currency: payment.currency,
         status: payment.status,
         customer_email: payment.customer_email,
```

**Why This Fix:**
`amount` is already stored as a number; the explicit `.toString()` was the only thing breaking it. Removing it is the smallest correct change. Wrapping the value in `parseFloat()` would be a no-op on a number and would hide the real cause. All three payment endpoints now return the same type.

**Testing:**
`GET /api/payments` returns `"amount":25.5` and `"amount":100` (numbers). `GET /api/payments/1` returns `"amount":25.5`.

---

## Fix 2: Maximum Payment Amount and Amount Validation (Bug B)

**Bug:** `POST /api/payments` accepted any amount (e.g. 999,999,999), and fractional cents.

**Files Changed:** `src/routes/payment.routes.js` (the constants are in the first hunk of Fix 1's diff)

**Code Changes:**
```diff
--- a/src/routes/payment.routes.js
+++ b/src/routes/payment.routes.js
@@ -68,13 +73,27 @@
     const { amount, currency, customer_email } = req.body;
 
     // Validation
-    if (!amount || isNaN(amount) || amount <= 0) {
+    // FIX (Bug B): reject booleans/null, anything that is not a plain decimal with
+    // max 2 decimal places, and enforce the maximum transaction amount.
+    // The string-based format check avoids float rounding issues (e.g. 1.15 * 100).
+    if (amount === undefined || amount === null || typeof amount === 'boolean') {
       return res.status(400).json({ error: 'Valid amount is required' });
     }
 
-    // BUG B: No maximum amount check - allows unrealistic amounts
-    // Real systems should have limits (e.g., max €50,000 per transaction)
-    // Missing: if (amount > 50000) { return 400 }
+    if (!AMOUNT_FORMAT.test(String(amount).trim())) {
+      return res.status(400).json({ error: 'Valid amount is required (maximum 2 decimal places)' });
+    }
+
+    const numericAmount = Number(String(amount).trim());
+    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
+      return res.status(400).json({ error: 'Valid amount is required' });
+    }
+
+    if (numericAmount > MAX_PAYMENT_AMOUNT) {
+      return res.status(400).json({
+        error: `Payment amount exceeds maximum allowed (${MAX_PAYMENT_AMOUNT} per transaction)`
+      });
+    }
 
     if (!currency || !['EUR', 'USD', 'GBP'].includes(currency)) {
       return res.status(400).json({ error: 'Valid currency is required (EUR, USD, GBP)' });
@@ -86,7 +105,7 @@
 
     const payment = createPayment({
       merchant_id: req.user.id,
-      amount: parseFloat(amount),
+      amount: numericAmount,
       currency,
       customer_email,
       status: 'pending'
```

**Why This Fix:**
- The limit is a named constant (`MAX_PAYMENT_AMOUNT`) so it is easy to find and change. The error text contains "maximum", as the assignment's example test expects.
- Validation uses a decimal-format regex on the string form instead of float arithmetic. A check like `Math.round(x * 100) !== x * 100` wrongly rejects valid amounts such as 0.07 and 1.15 because of floating point error.
- The regex rejects hex (`"0x10"`), scientific notation (`"1e9"`), negatives and more than 2 decimals. Booleans and null are rejected explicitly. Numbers and numeric strings that were valid before still work.
- The stored value is the validated number rather than a second `parseFloat(amount)`.

**Testing (observed status codes):**

| Input amount | Result |
| :--- | :--- |
| `999999999`, `50000.01` | 400 |
| `50000` (boundary), `0.07`, `1.15` | 201 |
| `10.999`, `"1e9"`, `"0x10"`, `"10abc"`, `true`, `-5`, `0` | 400 |

The 400 body for `999999` is `{"error":"Payment amount exceeds maximum allowed (50000 per transaction)"}`.

---

## Fix 3: Email Validation (Bug C)

**Bug:** The email regex accepted addresses with no TLD, such as `user@domain`.

**Files Changed:** `src/routes/auth.routes.js`

**Code Changes:**
```diff
--- a/src/routes/auth.routes.js
+++ b/src/routes/auth.routes.js
@@ -6,11 +6,13 @@
 const router = express.Router();
 const JWT_SECRET = 'test-secret-key-do-not-use-in-production';
 
-// BUG C: Email validation is too permissive
+// FIX (Bug C): require a dotted domain (labels separated by single dots, no leading/trailing
+// hyphen per label) and an alphabetic TLD of at least 2 characters, so "user@domain" is rejected.
+const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@([a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}$/;
+
 function validateEmail(email) {
-  // BUG: This regex allows emails without TLD like "user@domain"
-  const emailRegex = /^[^\s@]+@[^\s@]+$/;
-  return emailRegex.test(email);
+  if (typeof email !== 'string') return false;
+  return EMAIL_REGEX.test(email.trim());
 }
 
 // POST /api/auth/register
```

**Why This Fix:**
The domain must now be one or more dot-separated labels (no empty labels, no leading or trailing hyphen in a label) followed by an alphabetic TLD of at least 2 characters. The regex is hoisted to a constant so it is compiled once, and non-string input is rejected instead of throwing.

**Known limitation:** The local part still allows some RFC-invalid forms (e.g. `..a@domain.com`). A dedicated validation library would be the production answer; it was out of scope for a targeted fix.

**Testing (registration status codes):**
`user@domain`, `user@domain.`, `user@.com`, `user@domain..com` and `user@-a.com` all return 400. `a@b.co` and `user+t@sub.domain.eu` return 201.

---

## Fix 4: Webhook Signature Verification (Bug D)

**Bug:** `POST /api/webhooks/payment-status` ignored the `x-webhook-signature` header, so anyone could forge payment status changes.

**Files Changed:** `src/routes/webhook.routes.js`, `src/server.js`

**Code Changes:** (the `webhook.routes.js` diff also contains the Fix 5 changes, since both are in the same handler)
```diff
--- a/src/routes/webhook.routes.js
+++ b/src/routes/webhook.routes.js
@@ -4,8 +4,29 @@
 
 const router = express.Router();
 
-// Webhook secret for HMAC verification
-const WEBHOOK_SECRET = 'test-webhook-secret-key';
+// Webhook secret for HMAC verification (override via environment in real deployments)
+const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret-key';
+
+/**
+ * Verify the HMAC-SHA256 signature of a webhook request.
+ * Signs the raw request bytes when available (what providers actually sign), falling back to
+ * the re-serialised body. Uses a constant-time comparison to avoid timing attacks.
+ */
+function isValidSignature(req, signature) {
+  if (typeof signature !== 'string' || signature.length === 0) return false;
+
+  const payload = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
+  const expected = crypto
+    .createHmac('sha256', WEBHOOK_SECRET)
+    .update(payload)
+    .digest('hex');
+
+  // Compare as UTF-8 buffers of the hex strings. (Decoding the header as hex would silently
+  // drop invalid trailing characters.) timingSafeEqual throws on length mismatch, so check first.
+  const provided = Buffer.from(signature);
+  const wanted = Buffer.from(expected);
+  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
+}
 
 /**
  * POST /api/webhooks/payment-status
@@ -18,30 +39,26 @@
     const signature = req.headers['x-webhook-signature'];
     const { payment_id, status, event_id } = req.body;
 
-    // BUG D: No signature verification
-    // Real systems MUST verify webhook signatures to prevent spoofing
-    // Missing validation below:
-    
-    // const expectedSignature = crypto
-    //   .createHmac('sha256', WEBHOOK_SECRET)
-    //   .update(JSON.stringify(req.body))
-    //   .digest('hex');
-    // 
-    // if (signature !== expectedSignature) {
-    //   return res.status(401).json({ error: 'Invalid signature' });
-    // }
+    // FIX (Bug D): reject unsigned or incorrectly signed webhooks before touching any data
+    if (!signature) {
+      return res.status(401).json({ error: 'Webhook signature required' });
+    }
+    if (!isValidSignature(req, signature)) {
+      return res.status(401).json({ error: 'Invalid signature' });
+    }
 
     if (!payment_id || !status) {
       return res.status(400).json({ error: 'payment_id and status required' });
     }
 
-    // BUG E: No idempotency check
-    // Webhooks can be delivered multiple times - must be idempotent
-    // Missing check below:
-    
-    // if (db.processed_webhooks.includes(event_id)) {
-    //   return res.status(200).json({ message: 'Already processed' });
-    // }
+    // FIX (Bug E): webhooks can be delivered more than once - acknowledge duplicates
+    // (200 so the provider stops retrying) without re-applying the state change.
+    if (!event_id) {
+      return res.status(400).json({ error: 'event_id required' });
+    }
+    if (db.processed_webhooks.includes(event_id)) {
+      return res.status(200).json({ success: true, message: 'Already processed', event_id });
+    }
 
     const payment = getPaymentById(payment_id);
     if (!payment) {
@@ -52,8 +69,10 @@
     payment.status = status;
     payment.webhook_received_at = new Date();
 
-    // Mark webhook as processed (if idempotency was implemented)
-    // db.processed_webhooks.push(event_id);
+    // Record the event only after the update succeeded, so a webhook that failed
+    // (e.g. payment not found yet) can still be retried by the provider.
+    // No await between the check above and this push, so it is atomic in Node's event loop.
+    db.processed_webhooks.push(event_id);
 
     res.status(200).json({
       success: true,
```
```diff
--- a/src/server.js
+++ b/src/server.js
@@ -22,7 +22,12 @@
 
 // Middleware
 app.use(cors());
-app.use(express.json());
+// Keep the raw request bytes so webhook HMAC signatures are verified against what was actually sent
+app.use(express.json({
+  verify: (req, res, buf) => {
+    req.rawBody = buf;
+  }
+}));
 
 // Initialize database
 initDatabase();
```

**Why This Fix:**
- **Verified before anything else.** A missing header returns 401 "Webhook signature required"; a wrong one returns 401 "Invalid signature". No payment data is read or modified.
- **Raw body.** Providers sign the exact bytes they send, so `server.js` now keeps the raw request body (`req.rawBody`) and the HMAC is computed over it. Re-serialising with `JSON.stringify(req.body)` can produce different bytes and reject legitimate webhooks. If `rawBody` is ever unavailable, the code falls back to the re-serialised body.
- **Constant-time comparison.** `crypto.timingSafeEqual` prevents timing attacks. It throws on unequal lengths, so lengths are compared first.
- **Header compared as text, not decoded as hex.** Decoding with `Buffer.from(sig, 'hex')` silently stops at the first non-hex character, so `<valid signature>zz` would decode to the valid bytes and be accepted. Comparing the hex strings as UTF-8 buffers avoids that.
- The secret can be overridden with the `WEBHOOK_SECRET` environment variable; the existing default is kept so the assignment still runs out of the box.

**Testing:**

| Request | Result |
| :--- | :--- |
| No signature header | 401 "Webhook signature required" |
| `x-webhook-signature: fake` | 401 "Invalid signature" |
| Valid signature followed by `zz` | 401 "Invalid signature" |
| Valid signature for a different body | 401 "Invalid signature" |
| Payment status after the rejected requests | still `pending` |
| Correct HMAC-SHA256 (hex) of the exact body | 200, status updated to `completed` |

---

## Fix 5: Webhook Idempotency (Bug E)

**Bug:** Redelivered webhooks were re-applied, so a retried or replayed event could overwrite a payment's status.

**Files Changed:** `src/routes/webhook.routes.js` (see the diff under Fix 4)

**Why This Fix:**
- `event_id` is now required (400 if missing); without it there is nothing to deduplicate on.
- A repeated `event_id` returns **200** with "Already processed". A 2xx response tells the provider to stop retrying, whereas an error would trigger more retries.
- The event is recorded in `db.processed_webhooks` only **after** the update succeeds, so a webhook for a payment that does not exist yet (404) can be retried later.
- There is no `await` between the duplicate check and the `push`, so concurrent requests cannot interleave in Node's single-threaded event loop.
- The signature check runs first, so unauthenticated callers cannot poison the processed-events list.

**Testing:**

| Request | Result |
| :--- | :--- |
| Same `event_id` again with a different status (`refunded`) | 200 "Already processed"; status stays `completed` |
| Missing `event_id` | 400 "event_id required" |
| Unknown payment, sent twice | 404 both times (not marked processed) |
| 5 concurrent identical webhooks | 1 "Webhook processed", 4 "Already processed" |

---

## Fix 6: Duplicate Table Orders (Bug F)

**Bug:** A table could have several simultaneous orders.

**Files Changed:** `src/routes/table-order.routes.js`

**Code Changes:**
```diff
--- a/src/routes/table-order.routes.js
+++ b/src/routes/table-order.routes.js
@@ -5,6 +5,9 @@
 
 const router = express.Router();
 
+// Statuses in which an order still occupies its table (served/cancelled orders free it)
+const ACTIVE_ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'ready'];
+
 /**
  * GET /api/table-orders
  * List all table orders for authenticated merchant
@@ -41,18 +44,16 @@
       return res.status(400).json({ error: 'Order must have at least one item' });
     }
 
-    // BUG F: No duplicate order prevention
-    // Should check if table already has a pending order
-    // Missing validation below:
-    
-    // const existingOrder = (db.table_orders || []).find(
-    //   o => o.merchant_id === merchant_id && 
-    //        o.table_number === table_number && 
-    //        o.status === 'pending'
-    // );
-    // if (existingOrder) {
-    //   return res.status(409).json({ error: 'Table already has a pending order' });
-    // }
+    // FIX (Bug F): a table may only have one active order at a time.
+    // IDs/table numbers are compared as strings so 12 and "12" are the same table.
+    const existingOrder = (db.table_orders || []).find(
+      o => String(o.merchant_id) === String(merchant_id) &&
+           String(o.table_number) === String(table_number) &&
+           ACTIVE_ORDER_STATUSES.includes(o.status)
+    );
+    if (existingOrder) {
+      return res.status(409).json({ error: 'Table already has an active order' });
+    }
 
     // Calculate total
     const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
```

**Why This Fix:**
- `merchant_id` and `table_number` are compared as strings, so `12` and `"12"` (and `1` and `"1"`) are the same table. The original commented code used `===`, which a client could bypass by changing the type.
- A new order is blocked while the table has an order in any in-progress status: `pending`, `confirmed`, `preparing` or `ready`. `ready` is included because the food is prepared but not yet served, so the table is still occupied. `served` and `cancelled` free the table. The status list is a named constant.
- Returns 409 Conflict; the success response is unchanged.

**Testing:**

| Request | Result |
| :--- | :--- |
| First order, table 12 | 201 |
| Second order, table `"12"` (string) | 409 |
| Order for table 13 | 201 |
| Same table 12, different merchant | 201 |
| Table 12 after the first order is marked `served` | 201 |

---

## Fix 7: Duplicate E-Invoice Submission (Bug G)

**Bug:** The same invoice could be submitted repeatedly, creating a new `submission_id` each time and overwriting the original filing record.

**Files Changed:** `src/routes/einvoice.routes.js`

**Code Changes:**
```diff
--- a/src/routes/einvoice.routes.js
+++ b/src/routes/einvoice.routes.js
@@ -47,15 +47,13 @@
       });
     }
 
-    // BUG G: No duplicate submission check
-    // Should prevent submitting the same invoice twice
-    // Missing validation below:
-    
-    // if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
-    //   return res.status(409).json({ 
-    //     error: 'Invoice already submitted to tax authority' 
-    //   });
-    // }
+    // FIX (Bug G): an invoice may only be filed once. Runs after the ownership check so
+    // other merchants cannot probe submission state, and before a new submission_id is issued.
+    if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
+      return res.status(409).json({
+        error: 'Invoice already submitted to tax authority'
+      });
+    }
 
     // Simulate tax authority submission
     const submission_id = `SUB-${uuidv4()}`;
```

**Why This Fix:**
The check sits after authentication and the ownership check, so other merchants still get 403 and cannot probe submission state, and before a new `submission_id` is generated, so the original filing is never overwritten. A `rejected` status is deliberately not blocked, which leaves room for resubmission after a rejection.

**Testing:**
The first submit returns 200 with a `submission_id`. The second returns 409 "Invoice already submitted to tax authority". `GET /api/einvoice/status/inv_9001` still shows the original `submission_id`.

---

## Fix 8: Seeded Login Fixture (supporting change)

**Problem:** The seeded merchant's password hash was not a valid bcrypt hash of `Test123!`, so the README's own login example returned 401 and the example tests could not log in.

**Files Changed:** `src/db/database.js`

**Code Changes:**
```diff
--- a/src/db/database.js
+++ b/src/db/database.js
@@ -16,7 +16,7 @@
   db.users.push({
     id: "1",
     email: "merchant@test.com",
-    password: "$2a$10$8Z3KxGXvGqJQZ.ZF9Z3KxGXvGqJQZ.ZF9Z3KxGXvGqJQZ.ZF9", // password: Test123!
+    password: "$2a$10$MNdFLTg0edEaoYL7Z5jmAOo/.OKtyBryrn4wAX4ygTpgFUFI9ZWgC", // password: Test123! (bcrypt, 10 rounds)
     business_name: "Test Merchant",
     type: "merchant",
     created_at: new Date(),
```

**Why This Fix:** The hash was regenerated with `bcrypt.hashSync('Test123!', 10)`. This is test data only; the auth code itself is unchanged.

**Testing:** `POST /api/auth/login` with `merchant@test.com` / `Test123!` returns a token.

---

## Findings Documented but Deliberately Not Fixed

These are described in `bug-reports.md`. They were left unchanged to respect the "no breaking changes to API contracts" and "fix bugs, don't refactor" requirements, and are the first things I would raise with the team:

| Finding | Why it was not changed here |
| :--- | :--- |
| `POST /api/table-orders` has no authentication and trusts `merchant_id` from the body | Adding auth changes the contract for existing clients. It may also be intentional if diners place orders from a table QR code, in which case `merchant_id` should come from a signed table token. Needs a product decision. |
| Negative or `NaN` order totals (unvalidated `price` / `quantity`) | Adds new validation rules; the allowed ranges need product input. |
| `POST /api/webhooks/e-invoice` has no signature check | The tax authority's signing scheme is not specified. The Fix 4 helper can be reused once it is. |
| Webhook `status` is not validated against a list of lifecycle states | The allowed set and transitions are not defined in the assignment. |
| Socket.IO `new_order` / `order_status_changed` emission is commented out | A functional gap rather than one of the seven bugs; `req.app.get('io')` is available when it is enabled. |
| Hardcoded JWT and webhook secrets; login email case sensitivity | Configuration and normalisation changes that touch several files. |

## Verification Summary

- Manual end-to-end requests for Fixes 1 to 8, as listed above.
- `npm test`: the existing placeholder tests pass (2/2). Regression tests for each fix are covered separately in the test-writing task.
- `npm run verify-bugs`: 0/7 bug patterns remain.
