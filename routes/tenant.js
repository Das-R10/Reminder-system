// routes/tenant.js
const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const authTenant = require('../middleware/authTenant');
const tenantService  = require('../services/tenantService');
const paymentService = require('../services/paymentService');
const { getAllPlans, getChannelPlan } = require('../plans');

const upload = multer({ dest: 'uploads/' });

// ── GET /api/plans — public, returns all available plans ─────────────────────
router.get('/plans', (req, res) => {
  res.json(getAllPlans());
});

// ── GET /api/tenant/stats ─────────────────────────────────────────────────────
router.get('/tenant/stats', authTenant, async (req, res) => {
  try {
    const stats = await tenantService.getStats(req.user.id);
    if (!stats) return res.status(404).json({ error: 'Tenant not found' });
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── GET /api/jobs — recent job logs ──────────────────────────────────────────
router.get('/jobs', authTenant, async (req, res) => {
  try {
    const rows = await tenantService.getJobLogs(req.user.id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load jobs' });
  }
});

// ── POST /api/jobs — create single job (direct send) ─────────────────────────
router.post('/jobs', authTenant, async (req, res) => {
  const { channel, recipient, message } = req.body;

  if (!channel || !recipient || !message) {
    return res.status(400).json({ error: 'Missing fields: channel, recipient, message' });
  }

  try {
    const result = await tenantService.createJobWithLimitCheck(
      req.user.id, channel, recipient, message
    );
    res.json({ success: true, job_id: result.job_id });
  } catch (err) {
    const status =
      err.code === 'LIMIT_EXCEEDED'       ? 403 :
      err.code === 'CHANNEL_NOT_ENABLED'  ? 403 :
      err.code === 'TENANT_NOT_FOUND'     ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── POST /api/tenant/purchase — create purchase request ──────────────────────
router.post('/tenant/purchase', authTenant, async (req, res) => {
  const { plan_id, payment_method } = req.body;

  if (!plan_id || !payment_method) {
    return res.status(400).json({ error: 'Missing plan_id or payment_method' });
  }

  try {
    const result = await paymentService.createPurchaseRequest(
      req.user.id, plan_id, payment_method
    );
    res.json({
      success: true,
      request_id: result.request_id,
      amount: result.amount,
      message: 'Purchase request created. Complete payment and we will activate your plan within minutes.'
    });
  } catch (err) {
    const status = err.code === 'INVALID_PLAN' || err.code === 'INVALID_PAYMENT_METHOD' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── GET /api/tenant/purchase-history — tenant's own purchase requests ────────
router.get('/tenant/purchase-history', authTenant, async (req, res) => {
  try {
    const { rows } = await require('../db').pool.query(
      `SELECT id, plan_id, amount, payment_method, status, created_at, approved_at, notes
       FROM purchase_requests WHERE tenant_id=$1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load purchase history' });
  }
});

// ── POST /api/jobs/bulk-upload — CSV upload ───────────────────────────────────
router.post('/jobs/bulk-upload', authTenant, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file required' });

  try {
    const summary = await tenantService.bulkUploadJobsFromCsv(req.user.id, req.file.path);
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk upload failed' });
  }
});

// ── GET /api/tenant/upcoming-expiries ────────────────────────────────────────
router.get('/tenant/upcoming-expiries', authTenant, async (req, res) => {
  try {
    const { rows } = await require('../db').pool.query(
      `SELECT id,
              COALESCE(first_name,'') || ' ' || COALESCE(last_name,'') AS customer_name,
              expiry_date,
              (expiry_date - CURRENT_DATE) AS days_left
       FROM customers
       WHERE tenant_id=$1
         AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
       ORDER BY expiry_date`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load expiries' });
  }
});

module.exports = router;