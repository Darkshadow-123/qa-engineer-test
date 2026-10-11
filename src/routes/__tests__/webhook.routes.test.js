import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import {
  startServer,
  request,
  loginAsSeededMerchant,
  signWebhook,
  sendPaymentWebhook,
  uniqueId,
} from './helpers.js';

const TEST_PORT = 3103;
let server;
let token;

describe('Webhook Routes Tests (Port 3103)', () => {
  before(async () => {
    server = await startServer(TEST_PORT);
    token = await loginAsSeededMerchant(server.baseUrl);
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('Bug D: No x-webhook-signature header returns 401', async () => {
    const { status, body } = await request(
      server.baseUrl,
      'POST',
      '/api/webhooks/payment-status',
      {
        body: { payment_id: '1', status: 'completed', event_id: uniqueId('evt') },
      }
    );

    assert.strictEqual(status, 401);
    assert.ok(body?.error?.toLowerCase().includes('signature'));
  });

  test('Bug D: Wrong signature returns 401', async () => {
    const { status, body } = await request(
      server.baseUrl,
      'POST',
      '/api/webhooks/payment-status',
      {
        headers: { 'x-webhook-signature': 'badc0ffee1234567890abcdef' },
        body: { payment_id: '1', status: 'completed', event_id: uniqueId('evt') },
      }
    );

    assert.strictEqual(status, 401);
    assert.strictEqual(body.error, 'Invalid signature');
  });

  test('Bug D: Valid signature followed by "zz" returns 401 (hex decoding length guard)', async () => {
    const payload = { payment_id: '1', status: 'completed', event_id: uniqueId('evt') };
    const { rawBody, signature } = signWebhook(payload);
    const tamperedSig = signature + 'zz';

    const { status } = await request(
      server.baseUrl,
      'POST',
      '/api/webhooks/payment-status',
      {
        headers: { 'x-webhook-signature': tamperedSig },
        body: rawBody,
      }
    );

    assert.strictEqual(status, 401);
  });

  test('Bug D: Valid signature for a different body returns 401', async () => {
    const original = { payment_id: '1', status: 'completed', event_id: uniqueId('evt') };
    const { signature } = signWebhook(original);

    const tampered = { payment_id: '1', status: 'refunded', event_id: original.event_id };

    const { status } = await request(
      server.baseUrl,
      'POST',
      '/api/webhooks/payment-status',
      {
        headers: { 'x-webhook-signature': signature },
        body: tampered,
      }
    );

    assert.strictEqual(status, 401);
  });

  test('State Invariance: After a rejected webhook, payment status remains pending', async () => {
    // Create an isolated fresh payment to ensure order-independence
    const created = await request(server.baseUrl, 'POST', '/api/payments', {
      token,
      body: {
        amount: 25.0,
        currency: 'EUR',
        customer_email: `${uniqueId('cust_inv')}@example.com`,
      },
    });
    assert.strictEqual(created.status, 201);
    const paymentId = created.body.data.id;

    const payload = { payment_id: paymentId, status: 'completed', event_id: uniqueId('evt') };
    const { rawBody } = signWebhook(payload);

    // Send with invalid signature
    const rejected = await request(
      server.baseUrl,
      'POST',
      '/api/webhooks/payment-status',
      {
        headers: { 'x-webhook-signature': 'invalid-sig' },
        body: rawBody,
      }
    );
    assert.strictEqual(rejected.status, 401);

    // Verify payment is still pending
    const check = await request(server.baseUrl, 'GET', `/api/payments/${paymentId}`, { token });
    assert.strictEqual(check.status, 200);
    assert.strictEqual(check.body.data.status, 'pending');
  });

  test('Happy Path: Valid signature returns 200 and the status changes', async () => {
    const payload = { payment_id: '2', status: 'completed', event_id: uniqueId('evt') };
    const { status, body } = await sendPaymentWebhook(server.baseUrl, payload);

    assert.strictEqual(status, 200);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.new_status, 'completed');

    const verify = await request(server.baseUrl, 'GET', '/api/payments/2', { token });
    assert.strictEqual(verify.body.data.status, 'completed');
  });

  test('Bug E: Replay with same event_id and different status returns 200 "Already processed" and status is unchanged', async () => {
    const eventId = uniqueId('evt_replay');
    const firstPayload = { payment_id: '2', status: 'completed', event_id: eventId };

    const first = await sendPaymentWebhook(server.baseUrl, firstPayload);
    assert.strictEqual(first.status, 200);

    // Replay with same event_id but status 'refunded'
    const replayPayload = { payment_id: '2', status: 'refunded', event_id: eventId };
    const second = await sendPaymentWebhook(server.baseUrl, replayPayload);

    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.success, true);
    assert.strictEqual(second.body.message, 'Already processed');

    // Confirm payment status was NOT modified to refunded
    const check = await request(server.baseUrl, 'GET', '/api/payments/2', { token });
    assert.strictEqual(check.body.data.status, 'completed');
  });

  test('Bug E: Missing event_id returns 400', async () => {
    const payload = { payment_id: '1', status: 'completed' };
    const { status, body } = await sendPaymentWebhook(server.baseUrl, payload);

    assert.strictEqual(status, 400);
    assert.ok(body?.error?.includes('event_id'));
  });

  test('Retry Safety: Unknown payment returns 404 and does not mark event processed (retry after creating payment succeeds)', async () => {
    const retryEventId = uniqueId('evt_retryable');
    const initialPayload = { payment_id: '99999', status: 'completed', event_id: retryEventId };

    const res404 = await sendPaymentWebhook(server.baseUrl, initialPayload);
    assert.strictEqual(res404.status, 404);

    // Create the payment
    const created = await request(server.baseUrl, 'POST', '/api/payments', {
      token,
      body: {
        amount: 30,
        currency: 'EUR',
        customer_email: `${uniqueId('cust')}@example.com`,
      },
    });
    assert.strictEqual(created.status, 201);
    const newPaymentId = created.body.data.id;

    // Retry webhook with same event_id on the newly created payment
    const retryPayload = { payment_id: newPaymentId, status: 'completed', event_id: retryEventId };
    const retryRes = await sendPaymentWebhook(server.baseUrl, retryPayload);

    assert.strictEqual(retryRes.status, 200);
    assert.strictEqual(retryRes.body.message, 'Webhook processed');
  });

  test('Concurrency: Promise.all of 5 identical requests gives exactly one "Webhook processed" and four "Already processed"', async () => {
    const payload = { payment_id: '1', status: 'completed', event_id: uniqueId('evt_concurrent') };
    const { rawBody, headers } = signWebhook(payload);

    const calls = Array.from({ length: 5 }, () =>
      request(server.baseUrl, 'POST', '/api/webhooks/payment-status', {
        headers,
        body: rawBody,
      })
    );

    const responses = await Promise.all(calls);
    const processed = responses.filter(r => r.body?.message === 'Webhook processed').length;
    const duplicates = responses.filter(r => r.body?.message === 'Already processed').length;

    assert.strictEqual(processed, 1, 'Exactly one request processes the update');
    assert.strictEqual(duplicates, 4, 'Four requests are acknowledged as duplicates');
  });

  test('Malformed Payload: Malformed JSON returns 500 due to catch-all handler masking body-parser 400', async () => {
    const res = await fetch(`${server.baseUrl}/api/webhooks/payment-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': 'any-sig',
      },
      body: '{"invalid_json": ',
    });

    // Note: express.json() / body-parser instantiates a SyntaxError with status: 400.
    // However, server.js lines 106-109 contains a catch-all error handler that
    // unconditionally returns HTTP 500 with { error: "Something went wrong!" }.
    // We assert the observed production behavior (500) and document this architectural
    // defect as Finding 5 in bug-reports.md without introducing breaking handler changes.
    assert.strictEqual(res.status, 500);
    const data = await res.json();
    assert.strictEqual(data.error, 'Something went wrong!');
  });
});
