// Probe edge cases and secondary findings
const BASE_URL = 'http://localhost:3000';

async function probeEdgeCases() {
  console.log('Testing Edge Cases and Ancillary Vulnerabilities...\n');

  // Register a merchant
  const reg = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `edge_${Date.now()}@test.com`,
      password: 'Password123!',
      business_name: 'Edge Tester'
    })
  }).then(r => r.json());
  const token = reg.token;

  // 1. Bug B: Payment edge cases
  console.log('1. Payment amount edge cases:');
  const edgeAmounts = [50000.01, 10.999, "1e9", " 50 ", true, [50]];
  for (const amt of edgeAmounts) {
    const res = await fetch(`${BASE_URL}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ amount: amt, currency: 'EUR', customer_email: 'test@example.com' })
    });
    const data = await res.json();
    console.log(`  amount: ${JSON.stringify(amt)} -> status ${res.status}:`, data.data ? `accepted as ${data.data.amount}` : data.error);
  }

  // 2. Payments customer_email validation
  console.log('\n2. Payments customer_email validation:');
  const emailRes = await fetch(`${BASE_URL}/api/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ amount: 10, currency: 'EUR', customer_email: '@' })
  });
  console.log('  customer_email: "@" -> status', emailRes.status, await emailRes.json());

  // 3. Email case normalization
  console.log('\n3. Email case normalization:');
  const upperEmail = `CaseTest_${Date.now()}@domain.com`;
  await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: upperEmail, password: 'Password123!', business_name: 'Case Test' })
  });
  const lowerLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: upperEmail.toLowerCase(), password: 'Password123!' })
  });
  console.log(`  Register ${upperEmail}, Login ${upperEmail.toLowerCase()} -> status:`, lowerLoginRes.status, await lowerLoginRes.json());

  // 4. Table order edge cases: negative price/quantity and unauthenticated POST
  console.log('\n4. Table order unauthenticated & negative calculation:');
  const badOrderRes = await fetch(`${BASE_URL}/api/table-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      merchant_id: '1',
      table_number: 99,
      items: [{ name: 'Discount', price: -50, quantity: 1 }, { name: 'Item', price: 10, quantity: -2 }]
    })
  });
  console.log('  Negative prices / unauthenticated -> status:', badOrderRes.status, await badOrderRes.json());

  // 5. SIRET non-numeric
  console.log('\n5. SIRET non-numeric:');
  const siretRes = await fetch(`${BASE_URL}/api/einvoice/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ invoice_id: `inv_alpha_${Date.now()}`, customer_siret: 'abcdefghijklmn' })
  });
  console.log('  SIRET "abcdefghijklmn" -> status:', siretRes.status, await siretRes.json());
}

probeEdgeCases().catch(console.error);
