import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WEBHOOK_SECRET = 'test-webhook-secret-key'; // must match webhook.routes.js

let counter = 0;
/** Unique suffix so tests never collide on emails, event ids, table numbers or invoice ids. */
export function uniqueId(prefix = 'id') {
  counter += 1;
  return `${prefix}_${Date.now()}_${process.pid}_${counter}`;
}

/**
 * Start the API on its own port and wait until it reports it is listening.
 * Each test file should use a different port (test files run in separate processes in parallel).
 * Readiness is taken from the server's own startup log line rather than by polling the port,
 * so a port already used by another process is reported as an error instead of being mistaken
 * for our server. Returns { baseUrl, stop }.
 */
export function startServer(port) {
  const baseUrl = `http://localhost:${port}`;
  const child = spawn('node', ['src/server.js'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = async () => {
    child.kill();
    await exited;
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Server did not start within 10s on port ${port}:\n${output}`));
    }, 10_000);

    const onData = (chunk) => {
      output += chunk;
      if (output.includes('running on')) { // "EU Pay QA Test API running on http://localhost:PORT"
        clearTimeout(timer);
        resolve({ baseUrl, stop });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (port ${port} in use?):\n${output}`));
    });
  });
}

/** Send a JSON request. Returns { status, body, text } (body is null if the response is not JSON). */
export async function request(baseUrl, method, route, { body, token, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON response */ }
  return { status: res.status, body: parsed, text };
}

/** Log in as the seeded merchant (id "1", owns payments 1 and 2). */
export async function loginAsSeededMerchant(baseUrl) {
  const { status, body } = await request(baseUrl, 'POST', '/api/auth/login', {
    body: { email: 'merchant@test.com', password: 'Test123!' },
  });
  if (status !== 200) throw new Error(`Seeded login failed with ${status}`);
  return body.token;
}

/** Register a brand-new merchant and return { token, user, email }. Useful for ownership tests. */
export async function registerMerchant(baseUrl) {
  const email = `${uniqueId('merchant')}@example.com`;
  const { status, body } = await request(baseUrl, 'POST', '/api/auth/register', {
    body: { email, password: 'Password123!', business_name: 'Test Business' },
  });
  if (status !== 201) throw new Error(`Registration failed with ${status}`);
  return { token: body.token, user: body.user, email };
}

/**
 * Serialise a webhook payload and sign exactly those bytes.
 * Send `rawBody` as the request body and `headers` as the headers, so the signature matches.
 */
export function signWebhook(payload, secret = WEBHOOK_SECRET) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature, headers: { 'x-webhook-signature': signature } };
}

/** POST a signed payment-status webhook in one call. */
export function sendPaymentWebhook(baseUrl, payload) {
  const { rawBody, headers } = signWebhook(payload);
  return request(baseUrl, 'POST', '/api/webhooks/payment-status', { body: rawBody, headers });
}
