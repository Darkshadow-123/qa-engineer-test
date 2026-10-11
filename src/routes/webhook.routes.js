import express from 'express';
import crypto from 'crypto';
import { getPaymentById, db } from '../db/database.js';

const router = express.Router();

// Webhook secret for HMAC verification (override via environment in real deployments)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret-key';

/**
 * Verify the HMAC-SHA256 signature of a webhook request.
 * Signs the raw request bytes when available (what providers actually sign), falling back to
 * the re-serialised body. Uses a constant-time comparison to avoid timing attacks.
 */
function isValidSignature(req, signature) {
  if (typeof signature !== 'string' || signature.length === 0) return false;

  const payload = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  // Compare as UTF-8 buffers of the hex strings. (Decoding the header as hex would silently
  // drop invalid trailing characters.) timingSafeEqual throws on length mismatch, so check first.
  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
}

/**
 * POST /api/webhooks/payment-status
 * 
 * Simulates external payment provider webhooks (like Powens)
 * Tests webhook signature verification and idempotency
 */
router.post('/payment-status', (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const { payment_id, status, event_id } = req.body;

    // FIX (Bug D): reject unsigned or incorrectly signed webhooks before touching any data
    if (!signature) {
      return res.status(401).json({ error: 'Webhook signature required' });
    }
    if (!isValidSignature(req, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    if (!payment_id || !status) {
      return res.status(400).json({ error: 'payment_id and status required' });
    }

    // FIX (Bug E): webhooks can be delivered more than once - acknowledge duplicates
    // (200 so the provider stops retrying) without re-applying the state change.
    if (!event_id) {
      return res.status(400).json({ error: 'event_id required' });
    }
    if (db.processed_webhooks.includes(event_id)) {
      return res.status(200).json({ success: true, message: 'Already processed', event_id });
    }

    const payment = getPaymentById(payment_id);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Update payment status
    payment.status = status;
    payment.webhook_received_at = new Date();

    // Record the event only after the update succeeded, so a webhook that failed
    // (e.g. payment not found yet) can still be retried by the provider.
    // No await between the check above and this push, so it is atomic in Node's event loop.
    db.processed_webhooks.push(event_id);

    res.status(200).json({
      success: true,
      message: 'Webhook processed',
      payment_id,
      new_status: status
    });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * POST /api/webhooks/e-invoice
 * 
 * Simulates e-invoice submission webhook from tax authority
 */
router.post('/e-invoice', (req, res) => {
  try {
    const { invoice_id, status, submission_id, tax_authority_id } = req.body;

    if (!invoice_id || !status) {
      return res.status(400).json({ error: 'invoice_id and status required' });
    }

    // Find invoice in database
    const invoice = db.invoices?.find(inv => inv.id === invoice_id);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Update invoice status
    invoice.einvoice_status = status;
    invoice.einvoice_submission_id = submission_id;
    invoice.tax_authority_id = tax_authority_id;
    invoice.submitted_at = new Date();

    res.status(200).json({
      success: true,
      message: 'E-invoice webhook processed',
      invoice_id,
      status
    });
  } catch (error) {
    console.error('E-invoice webhook error:', error);
    res.status(500).json({ error: 'E-invoice webhook failed' });
  }
});

export default router;
