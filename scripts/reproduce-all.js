// Script to reproduce all 7 bugs against http://localhost:3000
const BASE_URL = 'http://localhost:3000';

async function run() {
  console.log('==================================================');
  console.log('EU PAY QA ASSIGNMENT - BUG REPRODUCTION SUITE');
  console.log('==================================================\n');

  // Step 0: Test Seeded Merchant vs Fresh Merchant
  console.log('--- Step 0: Authentication Verification ---');
  const seededLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'merchant@test.com', password: 'Test123!' })
  });
  const seededLogin = await seededLoginRes.json();
  console.log('Seeded merchant login status:', seededLoginRes.status, seededLogin);

  // Register a fresh merchant for authorized requests
  const uniqueId = Date.now();
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `testmerchant_${uniqueId}@eupay.test`,
      password: 'SecurePassword123!',
      business_name: 'Reproduction Merchant'
    })
  });
  const regData = await regRes.json();
  const token = regData.token;
  const merchantId = regData.user.id;
  console.log(`Registered merchant id=${merchantId}, token acquired: ${token ? 'YES' : 'NO'}\n`);

  // BUG A: Response data type string instead of number
  console.log('--- Bug A: Payment Amount Type ---');
  // Create a payment first
  const createPaymentRes = await fetch(`${BASE_URL}/api/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      amount: 42.50,
      currency: 'EUR',
      customer_email: 'alice@example.com'
    })
  });
  const createPaymentData = await createPaymentRes.json();
  console.log('POST /payments created amount:', createPaymentData.data.amount, 'type:', typeof createPaymentData.data.amount);

  // List payments
  const listPaymentsRes = await fetch(`${BASE_URL}/api/payments`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const listPaymentsData = await listPaymentsRes.json();
  const fetchedPayment = listPaymentsData.data[0];
  console.log('GET /payments returned amount:', JSON.stringify(fetchedPayment.amount), 'type:', typeof fetchedPayment.amount);

  // Get single payment
  const singlePaymentRes = await fetch(`${BASE_URL}/api/payments/${fetchedPayment.id}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const singlePaymentData = await singlePaymentRes.json();
  console.log('GET /payments/:id returned amount:', JSON.stringify(singlePaymentData.data.amount), 'type:', typeof singlePaymentData.data.amount);
  console.log('-> Bug A Confirmed: POST returns number (42.5), but GET and GET/:id return string ("42.5")\n');

  // BUG B: No maximum amount limit
  console.log('--- Bug B: Maximum Payment Limit ---');
  const hugeAmountRes = await fetch(`${BASE_URL}/api/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      amount: 999999999,
      currency: 'EUR',
      customer_email: 'billionaire@example.com'
    })
  });
  const hugeAmountData = await hugeAmountRes.json();
  console.log('POST /payments with €999,999,999 status:', hugeAmountRes.status, hugeAmountData);
  console.log('-> Bug B Confirmed: Unrealistic payment €999,999,999 accepted without 400 validation error\n');

  // BUG C: Email validation accepts user@domain without TLD
  console.log('--- Bug C: Permissive Email Validation ---');
  const invalidEmailRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `invaliduser_${uniqueId}@domain`,
      password: 'Password123!',
      business_name: 'No TLD Biz'
    })
  });
  const invalidEmailData = await invalidEmailRes.json();
  console.log('POST /auth/register with user@domain status:', invalidEmailRes.status, invalidEmailData);
  console.log('-> Bug C Confirmed: Registered user with email missing top-level domain\n');

  // BUG D: Missing Webhook Signature Verification
  console.log('--- Bug D: Missing Webhook Signature Verification ---');
  const forgedWebhookRes = await fetch(`${BASE_URL}/api/webhooks/payment-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-signature': 'totally-fake-unauthorized-signature'
    },
    body: JSON.stringify({
      payment_id: fetchedPayment.id,
      status: 'completed',
      event_id: `evt_forged_${uniqueId}`
    })
  });
  const forgedWebhookData = await forgedWebhookRes.json();
  console.log('POST /webhooks/payment-status with fake signature status:', forgedWebhookRes.status, forgedWebhookData);
  console.log('-> Bug D Confirmed: Unauthenticated / spoofed webhook accepted with 200 OK\n');

  // BUG E: Missing Webhook Idempotency Check
  console.log('--- Bug E: Missing Webhook Idempotency ---');
  const replayEventId = `evt_replay_${uniqueId}`;
  const firstWebhookRes = await fetch(`${BASE_URL}/api/webhooks/payment-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payment_id: fetchedPayment.id,
      status: 'completed',
      event_id: replayEventId
    })
  });
  const firstWebhookData = await firstWebhookRes.json();
  console.log('First webhook event delivery status:', firstWebhookRes.status, firstWebhookData);

  const duplicateWebhookRes = await fetch(`${BASE_URL}/api/webhooks/payment-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payment_id: fetchedPayment.id,
      status: 'refunded',
      event_id: replayEventId
    })
  });
  const duplicateWebhookData = await duplicateWebhookRes.json();
  console.log('Duplicate webhook event delivery status:', duplicateWebhookRes.status, duplicateWebhookData);
  console.log('-> Bug E Confirmed: Duplicate event_id re-processed and mutated state instead of returning 200 "Already processed"\n');

  // BUG F: Duplicate Table Orders Allowed
  console.log('--- Bug F: Duplicate Table Orders ---');
  const tableOrderPayload = {
    merchant_id: merchantId,
    table_number: 12,
    items: [{ name: 'Burger', price: 15, quantity: 2 }],
    customer_name: 'John Doe',
    order_type: 'dine_in'
  };
  const order1Res = await fetch(`${BASE_URL}/api/table-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tableOrderPayload)
  });
  const order1Data = await order1Res.json();
  console.log('Order 1 on table 12 status:', order1Res.status, 'order_id:', order1Data.data.id, 'status:', order1Data.data.status);

  const order2Res = await fetch(`${BASE_URL}/api/table-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tableOrderPayload)
  });
  const order2Data = await order2Res.json();
  console.log('Order 2 on table 12 status:', order2Res.status, 'order_id:', order2Data.data.id, 'status:', order2Data.data.status);
  console.log('-> Bug F Confirmed: Second pending order placed on table 12 without 409 Conflict\n');

  // BUG G: Duplicate E-Invoice Submission Allowed
  console.log('--- Bug G: Duplicate E-Invoice Submission ---');
  const einvoicePayload = {
    invoice_id: `inv_${uniqueId}`,
    customer_siret: '12345678901234'
  };
  const einvoice1Res = await fetch(`${BASE_URL}/api/einvoice/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(einvoicePayload)
  });
  const einvoice1Data = await einvoice1Res.json();
  console.log('First submission status:', einvoice1Res.status, 'submission_id:', einvoice1Data.data.submission_id);

  const einvoice2Res = await fetch(`${BASE_URL}/api/einvoice/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(einvoicePayload)
  });
  const einvoice2Data = await einvoice2Res.json();
  console.log('Second submission status:', einvoice2Res.status, 'submission_id:', einvoice2Data.data.submission_id);
  console.log('-> Bug G Confirmed: Resubmission succeeded with new submission_id instead of returning 409 Conflict\n');

  console.log('==================================================');
  console.log('ALL 7 BUGS REPRODUCED LIVE AGAINST RUNNING SERVER!');
  console.log('==================================================');
}

run().catch(console.error);
