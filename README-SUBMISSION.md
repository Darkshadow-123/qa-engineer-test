# EU Pay QA Engineer Assessment — Submission Overview

## Approach Summary
I prioritized production reliability, security hardening, and contract preservation by reproducing all seven intentional bugs and six ancillary findings through live exploratory testing before applying targeted, minimal fixes. Each fix resolves the root cause—such as timing-safe HMAC signature verification on raw request bytes and strict numeric boundary validation—without breaking existing API contracts. To guarantee long-term regression safety, I built a self-contained automated test suite of 32 tests across five test files using Node.js's native `node:test` runner. Every test file manages its own isolated server and in-memory database on a dedicated port, ensuring order independence, zero test flakiness, and fast ~1.8s execution.

---

## Deliverables Summary

| File | Purpose | Status |
| :--- | :--- | :--- |
| **[bug-reports.md](bug-reports.md)** | Detailed reports for all 7 intentional bugs + 6 ancillary security, fixture, and functional findings | Complete |
| **[fixes.md](fixes.md)** | Implementation documentation with git diffs, architectural rationale, and verified status codes | Complete |
| **[test-plan.md](test-plan.md)** | End-to-end testing strategy for the Webhook Payment Flow (14 scenarios, security, edge cases, risk assessment) | Complete |
| **[src/routes/\_\_tests\_\_/](src/routes/__tests__/)** | 32 automated regression tests across 5 test suites covering positive, negative, and edge cases | Complete |

---

## Bugs Found and Fixed

| Bug | Component | Severity | Issue | Solution |
| :--- | :--- | :--- | :--- | :--- |
| **Bug A** | Payment API | Medium | `GET /api/payments` and `GET /:id` converted amounts to strings via `.toString()`. | Removed `.toString()`; returned numeric amount consistently across all payment endpoints. |
| **Bug B** | Payment API | High | `POST /api/payments` lacked an upper transaction ceiling (accepting €999,999,999) and allowed fractional cents (`10.999`). | Added `MAX_PAYMENT_AMOUNT = 50000` and decimal format validation `/^\d+(\.\d{1,2})?$/`, safely accepting legitimate cents (`0.07`, `1.15`) while rejecting values > €50,000. |
| **Bug C** | Auth API | Medium | Permissive email regex `/^[^\s@]+@[^\s@]+$/` accepted incomplete domains without TLD (e.g. `user@domain`). | Enforced structured domain labels and 2+ character TLD using `/^[a-zA-Z0-9._%+-]+@([a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}$/`. |
| **Bug D** | Webhooks | Critical | `POST /api/webhooks/payment-status` ignored signatures, allowing unauthenticated status spoofing. | Captured `req.rawBody` in `express.json({ verify: ... })` and enforced HMAC-SHA256 signature verification with constant-time equality (`crypto.timingSafeEqual`). |
| **Bug E** | Webhooks | High | Missing idempotency check allowed duplicate deliveries of the same `event_id` to re-trigger state mutations. | Enforced `event_id` requirement, added atomic deduplication check returning `200 Already processed`, and recorded event IDs in `db.processed_webhooks`. |
| **Bug F** | Table Orders | Medium | Allowed multiple concurrent pending orders for the same dining table. | Added `ACTIVE_ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'ready']` check with dual string normalization for `merchant_id` and `table_number`, returning `409 Conflict`. |
| **Bug G** | E-Invoice | Medium | Allowed resubmitting already submitted/accepted e-invoices, overwriting submission IDs. | Enforced check returning `409 Conflict` if `invoice.einvoice_status === 'submitted' \|\| 'accepted'`. |
| **Fixture** | Database | Medium | Seeded merchant password hash in `src/db/database.js` was corrupted, blocking login. | Updated fixture with valid bcrypt hash for `Test123!`. |

---

## Automated Test Suite Highlights

- **Runner:** Node.js native test runner (`node:test`, `node:assert`).
- **Command:** `npm test` (mapped to `node --test "src/**/*.test.js"`).
- **Total Tests:** **32 passing tests** across 5 suites (0 failures):
  - `src/routes/__tests__/payment.routes.test.js`: 7 tests (Port 3102)
  - `src/routes/__tests__/auth.routes.test.js`: 5 tests (Port 3101)
  - `src/routes/__tests__/webhook.routes.test.js`: 11 tests (Port 3103)
  - `src/routes/__tests__/table-order.routes.test.js`: 5 tests (Port 3104)
  - `src/routes/__tests__/einvoice.routes.test.js`: 4 tests (Port 3105)
- **Execution Time:** ~1.8 seconds across all 5 suites running in parallel.
- **Mutation Testing:** Verified through deliberate mutation checks that tests actively go red when regressions are introduced:
  - *Bug E (Webhook Deduplication):* Commenting out the `db.processed_webhooks.includes(event_id)` check caused Test 7 (Replay) and Test 10 (Concurrency) to immediately fail with assertion errors.
  - *Bug D (Signature Hex Truncation):* Test 3 deliberately appends `'zz'` to an otherwise valid 64-character hex signature. If `Buffer.from(signature, 'hex')` without length validation were used, `Buffer.from` would silently truncate `'zz'` and incorrectly pass authentication; our explicit length guard and `timingSafeEqual` ensure this test goes red if length verification is omitted.

---

## Verification Commands

```bash
# 1. Verify all 7 bugs are fixed (reports 0/7 bugs present)
npm run verify-bugs

# 2. Run the complete automated test suite (runs 32 tests)
npm test

# 3. Start API server for manual exploratory testing
npm start
```
