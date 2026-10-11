import crypto from 'crypto';

const BASE_URL = 'http://localhost:3000';
const WEBHOOK_SECRET = 'test-webhook-secret-key';

async function testAllFixes() {
  console.log('==================================================');
  console.log('TESTING ALL APPLIED FIXES AGAINST RUNNING SERVER');
  console.log('==================================================\n');

  // Test Fixture: Seeded Merchant Login
  console.log('1. Testing Seeded Merchant Login (merchant@test.com / Test123!)...');
  const seededLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'merchant@test.com', password: 'Test123!' })
  });
  const seededLoginData = await seededLoginRes.json();
  console.log('   Status:', seededLoginRes.status, seededLoginData.message || seededLoginData.error);
  if (seededLoginRes.status !== 200) throw new Error('Seeded login failed');
  const token = seededLoginData.token;

  // Fix 1: Bug A - Numeric amount in GET endpoints
  console.log('\n2. Testing Bug A: Amount type in GET endpoints...');
  const paymentsListRes = await fetch(`${BASE_URL}/api/payments`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const paymentsListData = await paymentsListRes.json();
  const p1 = paymentsListData.data[0];
  console.log('   GET /payments amount:', p1.amount, 'typeof:', typeof p1.amount);
  if (typeof p1.amount !== 'number') throw new Error('Bug A failed: list amount is not number');

  const paymentDetailRes = await fetch(`${BASE_URL}/api/payments/1`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const paymentDetailData = await paymentDetailRes.json();
  console.log('   GET /payments/1 amount:', paymentDetailData.data.amount, 'typeof:', typeof paymentDetailData.data.amount);
  if (typeof paymentDetailData.data.amount !== 'number') throw new Error('Bug A failed: detail amount is not number');

  // Fix 2: Bug B - Maximum amount and decimal validation
  console.log('\n3. Testing Bug B: Maximum amount & decimal validations...');
  const overLimitRes = await fetch(`${BASE_URL}/api/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ amount: 999999, currency: 'EUR', customer_email: 'test@test.com' })
  });
  const overLimitData = await overLimitRes.json();
  console.log('   POST €999,999 status:', overLimitRes.status, 'error:', overLimitData.error);
  if (overLimitRes.status !== 400 || !overLimitData.error.includes('maximum')) throw new Error('Bug B failed on max check');

  const fracCentRes = await fetch(`${BASE_URL}/api/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ amount: 10.999, currency: 'EUR', customer_email: 'test@test.com' })
  });
  const fracCentData = await fracCentRes.json();
  console.log('   POST 10.999 status:', fracCentRes.status, 'error:', fracCentData.error);
  if (fracCentRes.status !== 400) throw new Error('Bug B failed on fractional cent check');

  const validSmallDecRes = await fetch(`${BASE_URL}/api/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ amount: 1.15, currency: 'EUR', customer_email: 'test@test.com' })
  });
  const validSmallDecData = await validSmallDecRes.json();
  console.log('   POST 1.15 status:', validSmallDecRes.status, 'created amount:', validSmallDecData.data?.amount);
  if (validSmallDecRes.status !== 201) throw new Error('Bug B rejected valid 1.15');

  // Fix 3: Bug C - Email regex
  console.log('\n4. Testing Bug C: Email domain validation...');
  const noTldRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'user@domain', password: 'Password123!', business_name: 'Biz' })
  });
  const noTldData = await noTldRes.json();
  console.log('   POST register user@domain status:', noTldRes.status, 'error:', noTldData.error);
  if (noTldRes.status !== 400) throw new Error('Bug C failed on user@domain');

  // Fix 4: Bug D - Webhook signature verification
  console.log('\n5. Testing Bug D: Webhook signature verification...');
  const webhookBody = JSON.stringify({ payment_id: '1', status: 'completed', event_id: 'evt_test_sig' });
  const unsignedRes = await fetch(`${BASE_URL}/api/webhooks/payment-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: webhookBody
  });
  console.log('   Unsigned webhook status:', unsignedRes.status, await unsignedRes.json());
  if (unsignedRes.status !== 401) throw new Error('Bug D failed: unsigned webhook was not 401');

  const badSigRes = await fetch(`${BASE_URL}/api/webhooks/payment-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': 'invalid-sig' },
    body: webhookBody
  });
  console.log('   Bad signature status:', badSigRes.status, await badSigRes.json());
  if (badSigRes.status !== 401) throw new Error('Bug D failed: bad signature was not 401');

  // Generate valid HMAC signature
  const validSig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(webhookBody)).digest('hex');
  const validSigRes = await fetch(`${BASE_URL}/api/webhooks/payment-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': validSig },
    body: webhookBody
  });
  const validSigData = await validSigRes.json();
  console.log('   Valid signature status:', validSigRes.status, validSigData.message);
  if (validSigRes.status !== 200) throw new Error('Bug D failed: valid signature was not 200');

  // Fix 5: Bug E - Webhook idempotency
  console.log('\n6. Testing Bug E: Webhook idempotency...');
  const replayRes = await fetch(`${BASE_URL}/api/webhooks/payment-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': validSig },
    body: webhookBody
  });
  const replayData = await replayRes.json();
  console.log('   Duplicate event status:', replayRes.status, replayData.message);
  if (replayRes.status !== 200 || replayData.message !== 'Already processed') {
    throw new Error('Bug E failed: duplicate webhook was not acknowledged as Already processed');
  }

  // Fix 6: Bug F - Table order duplicate active check
  console.log('\n7. Testing Bug F: Table order duplicate active prevention...');
  const tableOrderBody = {
    merchant_id: '1',
    table_number: 5,
    items: [{ name: 'Salad', price: 8.5, quantity: 1 }]
  };
  const order1Res = await fetch(`${BASE_URL}/api/table-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tableOrderBody)
  });
  console.log('   First order on table 5 status:', order1Res.status);

  const duplicateOrderRes = await fetch(`${BASE_URL}/api/table-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...tableOrderBody, table_number: '5' }) // string version
  });
  const duplicateOrderData = await duplicateOrderRes.json();
  console.log('   Duplicate order on table "5" status:', duplicateOrderRes.status, 'error:', duplicateOrderData.error);
  if (duplicateOrderRes.status !== 409) throw new Error('Bug F failed: duplicate table order was not 409');

  // Fix 7: Bug G - Duplicate e-invoice submission
  console.log('\n8. Testing Bug G: Duplicate e-invoice submission prevention...');
  const einvoiceBody = { invoice_id: 'inv_live_test_1', customer_siret: '12345678901234' };
  const einvoice1Res = await fetch(`${BASE_URL}/api/einvoice/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(einvoiceBody)
  });
  console.log('   First e-invoice submit status:', einvoice1Res.status);

  const einvoiceDuplicateRes = await fetch(`${BASE_URL}/api/einvoice/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(einvoiceBody)
  });
  const einvoiceDuplicateData = await einvoiceDuplicateRes.json();
  console.log('   Duplicate e-invoice submit status:', einvoiceDuplicateRes.status, 'error:', einvoiceDuplicateData.error);
  if (einvoiceDuplicateRes.status !== 409) throw new Error('Bug G failed: duplicate e-invoice submit was not 409');

  console.log('\n==================================================');
  console.log('ALL 7 FIXES TESTED AND VERIFIED SUCCESSFULLY!');
  console.log('==================================================');
}

testAllFixes().catch(err => {
  console.error('\n❌ Verification failed:', err);
  process.exit(1);
});
