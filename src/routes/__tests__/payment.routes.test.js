import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import { startServer, request, loginAsSeededMerchant, uniqueId } from './helpers.js';

const TEST_PORT = 3102;
let server;
let token;

describe('Payment Routes Tests (Port 3102)', () => {
  before(async () => {
    server = await startServer(TEST_PORT);
    token = await loginAsSeededMerchant(server.baseUrl);
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('Bug A: GET /payments returns amount as number', async () => {
    const { status, body } = await request(server.baseUrl, 'GET', '/api/payments', { token });

    assert.strictEqual(status, 200);
    assert.strictEqual(body.success, true);
    assert.ok(Array.isArray(body.data));
    const p1 = body.data.find(p => p.id === '1');
    assert.ok(p1, 'Seeded payment 1 must exist');
    assert.strictEqual(typeof p1.amount, 'number', 'amount must be a number, not string');
    assert.strictEqual(p1.amount, 25.5);
  });

  test('Bug A: GET /payments/1 also returns amount as number', async () => {
    const { status, body } = await request(server.baseUrl, 'GET', '/api/payments/1', { token });

    assert.strictEqual(status, 200);
    assert.strictEqual(body.success, true);
    assert.strictEqual(typeof body.data.amount, 'number', 'single payment amount must be a number');
    assert.strictEqual(body.data.amount, 25.5);
  });

  test('Bug B: POST 999999 returns 400 and error includes maximum', async () => {
    const { status, body } = await request(server.baseUrl, 'POST', '/api/payments', {
      token,
      body: {
        amount: 999999,
        currency: 'EUR',
        customer_email: `${uniqueId('cust')}@example.com`,
      },
    });

    assert.strictEqual(status, 400);
    assert.ok(body?.error, 'Error message must be present');
    assert.ok(
      body.error.toLowerCase().includes('maximum'),
      `Error "${body.error}" should mention "maximum"`
    );
  });

  test('Bug B Boundary: 50000 accepted and 50000.01 rejected', async () => {
    // 50,000 accepted
    const accepted = await request(server.baseUrl, 'POST', '/api/payments', {
      token,
      body: {
        amount: 50000,
        currency: 'EUR',
        customer_email: `${uniqueId('cust')}@example.com`,
      },
    });
    assert.strictEqual(accepted.status, 201);
    assert.strictEqual(accepted.body.data.amount, 50000);

    // 50,000.01 rejected
    const rejected = await request(server.baseUrl, 'POST', '/api/payments', {
      token,
      body: {
        amount: 50000.01,
        currency: 'EUR',
        customer_email: `${uniqueId('cust')}@example.com`,
      },
    });
    assert.strictEqual(rejected.status, 400);
  });

  test('Bug B Table-driven rejects: 10.999, "1e9", "0x10", true, -5, 0, "10abc" return 400', async () => {
    const rejects = [
      { val: 10.999, desc: 'fractional cent' },
      { val: '1e9', desc: 'scientific notation' },
      { val: '0x10', desc: 'hex string' },
      { val: true, desc: 'boolean true' },
      { val: -5, desc: 'negative' },
      { val: 0, desc: 'zero' },
      { val: '10abc', desc: 'alphanumeric string' },
    ];

    for (const { val, desc } of rejects) {
      const { status } = await request(server.baseUrl, 'POST', '/api/payments', {
        token,
        body: {
          amount: val,
          currency: 'EUR',
          customer_email: `${uniqueId('cust')}@example.com`,
        },
      });
      assert.strictEqual(status, 400, `Expected 400 for ${desc} (${JSON.stringify(val)})`);
    }
  });

  test('Bug B Table-driven accepts: 0.07, 1.15, "42.50" return 201 (float-rounding regression guard)', async () => {
    const accepts = [
      { val: 0.07, expected: 0.07, desc: 'small decimal 0.07' },
      { val: 1.15, expected: 1.15, desc: 'float-rounding sensitive 1.15' },
      { val: '42.50', expected: 42.5, desc: 'valid decimal string "42.50"' },
    ];

    for (const { val, expected, desc } of accepts) {
      const { status, body } = await request(server.baseUrl, 'POST', '/api/payments', {
        token,
        body: {
          amount: val,
          currency: 'EUR',
          customer_email: `${uniqueId('cust')}@example.com`,
        },
      });
      assert.strictEqual(status, 201, `Expected 201 for ${desc}`);
      assert.strictEqual(body.data.amount, expected);
    }
  });

  test('Payment Authentication: No token returns 401', async () => {
    const { status } = await request(server.baseUrl, 'POST', '/api/payments', {
      body: {
        amount: 25,
        currency: 'EUR',
        customer_email: `${uniqueId('cust')}@example.com`,
      },
    });
    assert.strictEqual(status, 401);
  });
});
