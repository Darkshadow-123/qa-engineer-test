import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import { startServer, request, loginAsSeededMerchant } from './helpers.js';

const TEST_PORT = 3104;
let server;
let token;

// Note: POST /api/table-orders is unauthenticated in the current API implementation,
// allowing guest devices at tables to place orders without a merchant Bearer token.
describe('Table Order Routes Tests (Port 3104)', () => {
  before(async () => {
    server = await startServer(TEST_PORT);
    token = await loginAsSeededMerchant(server.baseUrl);
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('Bug F: Second order on same table returns 409', async () => {
    const tableNum = 10;
    const orderPayload = {
      merchant_id: '1',
      table_number: tableNum,
      items: [{ name: 'Burger', price: 12.5, quantity: 2 }],
    };

    // First order on table succeeds
    const first = await request(server.baseUrl, 'POST', '/api/table-orders', {
      body: orderPayload,
    });
    assert.strictEqual(first.status, 201);
    assert.strictEqual(first.body.data.status, 'pending');

    // Duplicate order on same table returns 409
    const second = await request(server.baseUrl, 'POST', '/api/table-orders', {
      body: orderPayload,
    });
    assert.strictEqual(second.status, 409);
    assert.ok(
      second.body?.error?.toLowerCase().includes('active'),
      `Error "${second.body?.error}" should mention active order`
    );
  });

  test('Bug F: String "5" versus number 5 also returns 409', async () => {
    const tableNum = 15;

    // Create active order with numeric table number first (self-contained)
    const seedOrder = await request(server.baseUrl, 'POST', '/api/table-orders', {
      body: {
        merchant_id: '1',
        table_number: tableNum,
        items: [{ name: 'Burger', price: 10, quantity: 1 }],
      },
    });
    assert.strictEqual(seedOrder.status, 201);

    // Attempt second order using string table number representation
    const stringTableOrder = {
      merchant_id: '1',
      table_number: String(tableNum),
      items: [{ name: 'Fries', price: 4.0, quantity: 1 }],
    };
    const stringCheck = await request(server.baseUrl, 'POST', '/api/table-orders', {
      body: stringTableOrder,
    });

    assert.strictEqual(stringCheck.status, 409);
    assert.ok(stringCheck.body?.error?.toLowerCase().includes('active'));
  });

  test('Different table: Order on table 6 succeeds while table 5 is active', async () => {
    const orderTable6 = {
      merchant_id: '1',
      table_number: 6,
      items: [{ name: 'Pizza', price: 15.0, quantity: 1 }],
    };

    const res = await request(server.baseUrl, 'POST', '/api/table-orders', {
      body: orderTable6,
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.table_number, 6);
  });

  test('Different merchant: Same table number for another merchant is fine', async () => {
    const orderMerchant2 = {
      merchant_id: '2',
      table_number: 6, // same table as previous test, but different merchant
      items: [{ name: 'Coffee', price: 3.5, quantity: 2 }],
    };

    const res = await request(server.baseUrl, 'POST', '/api/table-orders', {
      body: orderMerchant2,
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.merchant_id, '2');
  });

  test('Lifecycle Resolution: After PATCH to served, table accepts a new order', async () => {
    const tableNum = 20;

    // Place initial order on table 20
    const created = await request(server.baseUrl, 'POST', '/api/table-orders', {
      body: {
        merchant_id: '1',
        table_number: tableNum,
        items: [{ name: 'Soup', price: 7.0, quantity: 1 }],
      },
    });
    assert.strictEqual(created.status, 201);
    const orderId = created.body.data.id;

    // Update status to 'served' (requires authentication)
    const patched = await request(
      server.baseUrl,
      'PATCH',
      `/api/table-orders/${orderId}/status`,
      {
        token,
        body: { status: 'served' },
      }
    );
    assert.strictEqual(patched.status, 200);
    assert.strictEqual(patched.body.data.status, 'served');

    // Place new order on table 20 (now freed)
    const newOrder = await request(server.baseUrl, 'POST', '/api/table-orders', {
      body: {
        merchant_id: '1',
        table_number: tableNum,
        items: [{ name: 'Dessert', price: 6.0, quantity: 1 }],
      },
    });
    assert.strictEqual(newOrder.status, 201);
    assert.strictEqual(newOrder.body.data.status, 'pending');
  });
});
