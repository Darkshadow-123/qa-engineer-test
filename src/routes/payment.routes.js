import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { createPayment, getPayments, getPaymentById } from '../db/database.js';

const router = express.Router();

// Business rule: maximum value of a single payment, in the payment currency
const MAX_PAYMENT_AMOUNT = 50000;
// Plain decimal with at most 2 fractional digits (rejects hex, scientific notation, negatives, fractional cents)
const AMOUNT_FORMAT = /^\d+(\.\d{1,2})?$/;

// GET /api/payments - List all payments for authenticated merchant
router.get('/', authenticate, (req, res) => {
  try {
    const merchantId = req.user.id;
    const payments = getPayments(merchantId);

    // FIX (Bug A): amount is stored as a number and must be returned as a number
    const formattedPayments = payments.map(p => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      customer_email: p.customer_email,
      created_at: p.created_at
    }));

    res.json({
      success: true,
      data: formattedPayments,
      count: formattedPayments.length
    });
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// GET /api/payments/:id - Get single payment
router.get('/:id', authenticate, (req, res) => {
  try {
    const payment = getPaymentById(req.params.id);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Verify ownership
    if (payment.merchant_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      success: true,
      data: {
        id: payment.id,
        amount: payment.amount, // FIX (Bug A): keep numeric type, consistent with POST response
        currency: payment.currency,
        status: payment.status,
        customer_email: payment.customer_email,
        created_at: payment.created_at
      }
    });
  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

// POST /api/payments - Create new payment
router.post('/', authenticate, (req, res) => {
  try {
    const { amount, currency, customer_email } = req.body;

    // Validation
    // FIX (Bug B): reject booleans/null, anything that is not a plain decimal with
    // max 2 decimal places, and enforce the maximum transaction amount.
    // The string-based format check avoids float rounding issues (e.g. 1.15 * 100).
    if (amount === undefined || amount === null || typeof amount === 'boolean') {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    if (!AMOUNT_FORMAT.test(String(amount).trim())) {
      return res.status(400).json({ error: 'Valid amount is required (maximum 2 decimal places)' });
    }

    const numericAmount = Number(String(amount).trim());
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    if (numericAmount > MAX_PAYMENT_AMOUNT) {
      return res.status(400).json({
        error: `Payment amount exceeds maximum allowed (${MAX_PAYMENT_AMOUNT} per transaction)`
      });
    }

    if (!currency || !['EUR', 'USD', 'GBP'].includes(currency)) {
      return res.status(400).json({ error: 'Valid currency is required (EUR, USD, GBP)' });
    }

    if (!customer_email || !customer_email.includes('@')) {
      return res.status(400).json({ error: 'Valid customer email is required' });
    }

    const payment = createPayment({
      merchant_id: req.user.id,
      amount: numericAmount,
      currency,
      customer_email,
      status: 'pending'
    });

    res.status(201).json({
      success: true,
      message: 'Payment created',
      data: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        customer_email: payment.customer_email
      }
    });
  } catch (error) {
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

export default router;
