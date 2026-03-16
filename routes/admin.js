// routes/admin.js — all /api/admin/* platform-admin endpoints
const express = require('express');
const router  = express.Router();

const { pool, writeAudit } = require('../db');
const paymentService   = require('../services/paymentService');
const { requireAdmin } = require('../middleware/auth');

const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;

// ── Stats ──────────────────────────────────────────────────────────────────────
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [tenants, jobs, sent, failed, pendingPayments] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM tenants WHERE role='user'`),
      pool.query(`SELECT COUNT(*) FROM jobs`),
      pool.query(`SELECT COUNT(*) FROM jobs WHERE status='sent'`),
      pool.query(`SELECT COUNT(*) FROM jobs WHERE status IN ('failed','permanent_failed')`),
      pool.query(`SELECT COUNT(*) FROM purchase_requests WHERE status='pending'`),
    ]);
    res.json({
      total_tenants:    tenants.rows[0].count,
      total_jobs:       jobs.rows[0].count,
      sent_jobs:        sent.rows[0].count,
      failed_jobs:      failed.rows[0].count,
      pending_payments: pendingPayments.rows[0].count,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tenant list ────────────────────────────────────────────────────────────────
router.get('/tenants', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.email, t.role, t.active_plans, t.created_at,
              (SELECT COUNT(*) FROM customers c WHERE c.tenant_id=t.id) AS customer_count,
              (SELECT COUNT(*) FROM jobs j WHERE j.tenant_id=t.id AND j.status='sent') AS jobs_sent
       FROM tenants t ORDER BY t.created_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Activate plan for a tenant ─────────────────────────────────────────────────
router.post('/tenants/:id/activate-plan', requireAdmin, async (req, res) => {
  const { plan_id } = req.body;
  if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
  try {
    await pool.query(
      `UPDATE tenants SET active_plans = (
         SELECT jsonb_agg(DISTINCT val)
         FROM (
           SELECT jsonb_array_elements_text(COALESCE(active_plans,'[]'::jsonb)) AS val
           UNION ALL SELECT $2::text
         ) sub
       ) WHERE id=$1`,
      [req.params.id, plan_id]
    );
    writeAudit({ tenant_id: parseInt(req.params.id), actor_id: req.user.id, actor_email: req.user.email,
      action: 'plan_activated', target_type: 'tenant', target_id: req.params.id,
      meta: { plan_id }, ip: clientIp(req) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Purchase requests ──────────────────────────────────────────────────────────
router.get('/purchases', requireAdmin, async (req, res) => {
  try {
    res.json(await paymentService.getAllPurchaseRequests(req.query.status || null));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/purchases/:id/approve', requireAdmin, async (req, res) => {
  try {
    const result = await paymentService.approvePurchaseRequest(parseInt(req.params.id), req.user.id);
    writeAudit({ tenant_id: result.tenant_id, actor_id: req.user.id, actor_email: req.user.email,
      action: 'purchase_approved', target_type: 'purchase_request', target_id: req.params.id,
      meta: { plan_id: result.plan_id }, ip: clientIp(req) });
    res.json({ success: true, ...result });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'ALREADY_PROCESSED' ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/purchases/:id/reject', requireAdmin, async (req, res) => {
  try {
    await paymentService.rejectPurchaseRequest(parseInt(req.params.id), req.user.id, req.body.notes || '');
    writeAudit({ actor_id: req.user.id, actor_email: req.user.email,
      action: 'purchase_rejected', target_type: 'purchase_request', target_id: req.params.id,
      meta: { notes: req.body.notes }, ip: clientIp(req) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Audit log viewer (admin sees all tenants) ──────────────────────────────────
// GET /api/admin/audit?tenant_id=&action=&limit=100&offset=0
router.get('/audit', requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '100'), 500);
    const offset = Math.max(parseInt(req.query.offset || '0'),   0);
    const conds  = [], params = [];
    if (req.query.tenant_id) { conds.push(`al.tenant_id=$${params.length+1}`);           params.push(parseInt(req.query.tenant_id)); }
    if (req.query.action)    { conds.push(`al.action ILIKE $${params.length+1}`);         params.push(`%${req.query.action}%`); }
    if (req.query.actor)     { conds.push(`al.actor_email ILIKE $${params.length+1}`);    params.push(`%${req.query.actor}%`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT al.*, t.name AS tenant_name
       FROM audit_log al LEFT JOIN tenants t ON t.id = al.tenant_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Hard-delete tenant (admin GDPR tool) ──────────────────────────────────────
router.delete('/tenants/:id', requireAdmin, async (req, res) => {
  const tenantId = parseInt(req.params.id);
  if (tenantId === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    // Write audit first (FK will null the tenant_id after delete anyway)
    await writeAudit({ tenant_id: tenantId, actor_id: req.user.id, actor_email: req.user.email,
      action: 'admin_tenant_deleted', target_type: 'tenant', target_id: String(tenantId), ip: clientIp(req) });
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
    res.json({ success: true, deleted: tenantId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
