import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import {
  startServer,
  request,
  loginAsSeededMerchant,
  registerMerchant,
  uniqueId,
} from './helpers.js';

const TEST_PORT = 3105;
let server;
let merchant1Token;
let merchant2Token;

describe('E-Invoice Routes Tests (Port 3105)', () => {
  before(async () => {
    server = await startServer(TEST_PORT);
    merchant1Token = await loginAsSeededMerchant(server.baseUrl);
    const m2 = await registerMerchant(server.baseUrl);
    merchant2Token = m2.token;
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('Bug G: First submit returns 200, and second returns 409', async () => {
    const invoiceId = uniqueId('inv');
    const payload = {
      invoice_id: invoiceId,
      customer_siret: '12345678901234',
    };

    // First submission returns 200
    const first = await request(server.baseUrl, 'POST', '/api/einvoice/submit', {
      token: merchant1Token,
      body: payload,
    });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.data.status, 'submitted');
    assert.ok(first.body.data.submission_id.startsWith('SUB-'));

    // Second submission returns 409
    const second = await request(server.baseUrl, 'POST', '/api/einvoice/submit', {
      token: merchant1Token,
      body: payload,
    });
    assert.strictEqual(second.status, 409);
    assert.ok(
      second.body?.error?.toLowerCase().includes('submitted'),
      `Error "${second.body?.error}" should mention submitted`
    );
  });

  test('Audit Trail Invariance: Stored submission_id is unchanged after rejected resubmit', async () => {
    const invoiceId = uniqueId('inv_audit');
    const payload = {
      invoice_id: invoiceId,
      customer_siret: '98765432109876',
    };

    // Initial submit
    const first = await request(server.baseUrl, 'POST', '/api/einvoice/submit', {
      token: merchant1Token,
      body: payload,
    });
    const originalSubmissionId = first.body.data.submission_id;

    // Rejected resubmit
    const rejected = await request(server.baseUrl, 'POST', '/api/einvoice/submit', {
      token: merchant1Token,
      body: payload,
    });
    assert.strictEqual(rejected.status, 409);

    // Query status to confirm submission_id didn't change
    const statusQuery = await request(
      server.baseUrl,
      'GET',
      `/api/einvoice/status/${invoiceId}`,
      { token: merchant1Token }
    );
    assert.strictEqual(statusQuery.status, 200);
    assert.strictEqual(statusQuery.body.data.submission_id, originalSubmissionId);
  });

  test('Ownership Isolation: Another merchant gets 403 for that invoice', async () => {
    const invoiceId = uniqueId('inv_isolated');

    // Merchant 1 creates invoice
    await request(server.baseUrl, 'POST', '/api/einvoice/submit', {
      token: merchant1Token,
      body: {
        invoice_id: invoiceId,
        customer_siret: '11112222333344',
      },
    });

    // Merchant 2 attempts to query status
    const m2Query = await request(
      server.baseUrl,
      'GET',
      `/api/einvoice/status/${invoiceId}`,
      { token: merchant2Token }
    );
    assert.strictEqual(m2Query.status, 403);

    // Merchant 2 attempts to submit
    const m2Submit = await request(server.baseUrl, 'POST', '/api/einvoice/submit', {
      token: merchant2Token,
      body: {
        invoice_id: invoiceId,
        customer_siret: '11112222333344',
      },
    });
    assert.strictEqual(m2Submit.status, 403);
  });

  test('Bad SIRET: Wrong length returns 400', async () => {
    // API Quirk note: In POST /api/einvoice/submit, if an invoice record does not exist yet,
    // it is automatically initialized as a 'draft' before customer_siret validation runs.
    // Consequently, a request rejected with 400 leaves behind a stray draft invoice in the DB.
    const res = await request(server.baseUrl, 'POST', '/api/einvoice/submit', {
      token: merchant1Token,
      body: {
        invoice_id: uniqueId('inv_badsiret'),
        customer_siret: '12345', // 5 digits instead of 14
      },
    });

    assert.strictEqual(res.status, 400);
    assert.ok(res.body?.error?.includes('SIRET'));
  });
});
