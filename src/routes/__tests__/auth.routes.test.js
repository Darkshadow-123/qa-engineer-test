import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import { startServer, request, uniqueId } from './helpers.js';

const TEST_PORT = 3101;
let server;

describe('Auth Routes Tests (Port 3101)', () => {
  before(async () => {
    server = await startServer(TEST_PORT);
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('Bug C Rejects: user@domain, user@domain., user@.com, user@domain..com, user@-a.com, spaces return 400', async () => {
    const invalidEmails = [
      { email: 'user@domain', desc: 'missing TLD' },
      { email: 'user@domain.', desc: 'trailing dot' },
      { email: 'user@.com', desc: 'missing domain label' },
      { email: 'user@domain..com', desc: 'consecutive dots' },
      { email: 'user@-a.com', desc: 'domain label starting with hyphen' },
      { email: 'user@a-.com', desc: 'domain label ending with hyphen' },
      { email: 'user name@domain.com', desc: 'string with spaces' },
    ];

    for (const { email, desc } of invalidEmails) {
      const { status } = await request(server.baseUrl, 'POST', '/api/auth/register', {
        body: {
          email,
          password: 'Password123!',
          business_name: 'Test Business',
        },
      });

      assert.strictEqual(status, 400, `Expected 400 for ${desc} (${email})`);
    }
  });

  test('Bug C Accepts: valid complex formats (short domain, subdomain, plus-tag) return 201', async () => {
    // Unique local-parts prevent 409 conflicts while testing short domains (b.co) and subdomains with plus-tags
    const validEmails = [
      `${uniqueId('user')}@b.co`,
      `${uniqueId('user')}+tag@sub.domain.eu`,
    ];

    for (const email of validEmails) {
      const { status, body } = await request(server.baseUrl, 'POST', '/api/auth/register', {
        body: {
          email,
          password: 'ValidPassword123!',
          business_name: 'Valid Corp',
        },
      });

      assert.strictEqual(status, 201, `Expected 201 for ${email}`);
      assert.strictEqual(body.user.email, email);
      assert.ok(body.token, 'Token must be issued upon registration');
    }
  });

  test('Seeded merchant login: merchant@test.com / Test123! logs in with 200', async () => {
    const { status, body } = await request(server.baseUrl, 'POST', '/api/auth/login', {
      body: {
        email: 'merchant@test.com',
        password: 'Test123!',
      },
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(body.user.email, 'merchant@test.com');
    assert.ok(body.token, 'JWT token must be returned');
  });

  test('Login Negative: Wrong password returns 401', async () => {
    const { status } = await request(server.baseUrl, 'POST', '/api/auth/login', {
      body: {
        email: 'merchant@test.com',
        password: 'WrongPassword999!',
      },
    });

    assert.strictEqual(status, 401);
  });

  test('Registration Conflict: Duplicate registration gives 409', async () => {
    const email = `${uniqueId('dup')}@example.com`;

    const first = await request(server.baseUrl, 'POST', '/api/auth/register', {
      body: {
        email,
        password: 'Password123!',
        business_name: 'Original Biz',
      },
    });
    assert.strictEqual(first.status, 201);

    const second = await request(server.baseUrl, 'POST', '/api/auth/register', {
      body: {
        email,
        password: 'Password123!',
        business_name: 'Duplicate Biz',
      },
    });
    assert.strictEqual(second.status, 409);
  });
});
