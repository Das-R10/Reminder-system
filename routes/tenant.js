// routes/tenant.js — Phase 5
// All tenant-facing endpoints: stats, analytics, team management,
// own audit log, GDPR export/delete, jobs, DLQ, customers, billing
const express = require('express');
const router  = express.Router();
const multer  = require('multer');

const { pool, writeAudit } = require('../db');
const tenantService  = require('../services/tenantService');
const paymentService = require('../services/paymentService');
const { requireTenant, requireOwner } = require('../middleware/auth');

const upload   = multer({ dest: 'uploads/' });
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;

// ─────────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/tenant/stats', requireTenant, async (req, res) => {
  try {
    const stats = await tenantService.getStats(req.user.id);
    if (!stats) return res.status(404).json({ error: 'Tenant not found' });
    res.json(stats);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load stats' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS  GET /api/analytics?months=6
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics', requireTenant, async (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months || '6'), 24);

    const [deliveryRates, monthlyTrend, expiryBuckets] = await Promise.all([
      // Delivery & open rates by channel
      pool.query(`
        SELECT
          channel,
          COUNT(*)                                              AS total,
          COUNT(*) FILTER (WHERE status = 'sent')              AS sent,
          COUNT(*) FILTER (WHERE status = 'permanent_failed')  AS perm_failed,
          COUNT(*) FILTER (WHERE delivery_status = 'delivered') AS delivered,
          COUNT(*) FILTER (WHERE delivery_status = 'opened')    AS opened,
          COUNT(*) FILTER (WHERE delivery_status = 'bounced')   AS bounced
        FROM jobs WHERE tenant_id=$1 GROUP BY channel ORDER BY channel`,
        [req.user.id]
      ),

      // Monthly send volume per channel, last N months
      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
          channel,
          COUNT(*) FILTER (WHERE status = 'sent')             AS sent,
          COUNT(*) FILTER (WHERE status = 'permanent_failed') AS failed
        FROM jobs
        WHERE tenant_id=$1
          AND created_at >= NOW() - ($2 || ' months')::interval
        GROUP BY 1, 2
        ORDER BY 1, 2`,
        [req.user.id, months]
      ),

      // Expiry urgency buckets
      pool.query(`
        SELECT
          CASE
            WHEN expiry_date - CURRENT_DATE BETWEEN 0  AND 7  THEN '0–7 days'
            WHEN expiry_date - CURRENT_DATE BETWEEN 8  AND 14 THEN '8–14 days'
            WHEN expiry_date - CURRENT_DATE BETWEEN 15 AND 30 THEN '15–30 days'
          END AS bucket,
          COUNT(*) AS count
        FROM customers
        WHERE tenant_id=$1
          AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
        GROUP BY 1 ORDER BY MIN(expiry_date - CURRENT_DATE)`,
        [req.user.id]
      ),
    ]);

    res.json({
      delivery_rates: deliveryRates.rows,
      monthly_trend:  monthlyTrend.rows,
      expiry_buckets: expiryBuckets.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEAM MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
router.get('/team', requireTenant, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tm.id, tm.team_role, tm.created_at, t.name, t.email
       FROM team_members tm
       JOIN tenants t ON t.id = tm.user_id
       WHERE tm.org_id = $1
       ORDER BY tm.created_at`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load team' }); }
});

// POST /api/team/invite  — owner only
router.post('/team/invite', requireOwner, async (req, res) => {
  const { email, team_role = 'member' } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  if (!['owner', 'member'].includes(team_role))
    return res.status(400).json({ error: 'team_role must be owner or member' });

  try {
    // Find or create stub account for the invitee
    let { rows } = await pool.query('SELECT id FROM tenants WHERE email=$1', [email]);
    let userId;
    if (rows.length) {
      userId = rows[0].id;
    } else {
      const r = await pool.query(
        `INSERT INTO tenants (name, email, role) VALUES ($1,$2,'user') RETURNING id`,
        [email.split('@')[0], email]
      );
      userId = r.rows[0].id;
    }

    await pool.query(
      `INSERT INTO team_members (org_id, user_id, team_role, invited_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, user_id) DO UPDATE SET team_role = EXCLUDED.team_role`,
      [req.user.id, userId, team_role, req.user.id]
    );

    writeAudit({ tenant_id: req.user.id, actor_id: req.user.id, actor_email: req.user.email,
      action: 'team_member_invited', target_type: 'user', target_id: userId,
      meta: { email, team_role }, ip: clientIp(req) });

    res.json({ success: true, user_id: userId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/team/:memberId — owner only
router.delete('/team/:memberId', requireOwner, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM team_members WHERE org_id=$1 AND id=$2',
      [req.user.id, req.params.memberId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Member not found' });
    writeAudit({ tenant_id: req.user.id, actor_id: req.user.id, actor_email: req.user.email,
      action: 'team_member_removed', target_type: 'team_member', target_id: req.params.memberId,
      ip: clientIp(req) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG — tenant's own view
// ─────────────────────────────────────────────────────────────────────────────
router.get('/audit', requireTenant, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50'), 200);
    const offset = Math.max(parseInt(req.query.offset || '0'),  0);
    const { rows } = await pool.query(
      `SELECT id, actor_email, action, target_type, target_id, meta, ip, created_at
       FROM audit_log
       WHERE tenant_id=$1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load audit log' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GDPR — data export
// ─────────────────────────────────────────────────────────────────────────────
router.get('/gdpr/export', requireOwner, async (req, res) => {
  const tenantId = req.user.id;
  try {
    const [accountR, customersR, jobsR, rulesR, purchasesR, teamR, consentsR] = await Promise.all([
      pool.query(`SELECT id, name, email, active_plans, created_at FROM tenants WHERE id=$1`, [tenantId]),
      pool.query(`SELECT customer_id, first_name, last_name, email, phone,
                         expiry_date::text, created_at FROM customers WHERE tenant_id=$1`, [tenantId]),
      pool.query(`SELECT id, channel, recipient, status, delivery_status,
                         scheduled_at, created_at FROM jobs WHERE tenant_id=$1`, [tenantId]),
      pool.query(`SELECT id, name, lead_days, channels, is_active, created_at FROM rules WHERE tenant_id=$1`, [tenantId]),
      pool.query(`SELECT id, plan_id, amount, status, created_at FROM purchase_requests WHERE tenant_id=$1`, [tenantId]),
      pool.query(`SELECT tm.team_role, t.email FROM team_members tm
                  JOIN tenants t ON t.id=tm.user_id WHERE tm.org_id=$1`, [tenantId]),
      pool.query(`SELECT tos_version, pp_version, accepted_at, ip FROM legal_consents WHERE tenant_id=$1`, [tenantId]),
    ]);

    writeAudit({ tenant_id: tenantId, actor_id: req.user.id, actor_email: req.user.email,
      action: 'gdpr_data_exported', ip: clientIp(req) });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="renewpulse-export-${tenantId}.json"`);
    res.json({
      exported_at:    new Date().toISOString(),
      account:        accountR.rows[0],
      customers:      customersR.rows,
      jobs:           jobsR.rows,
      rules:          rulesR.rows,
      purchases:      purchasesR.rows,
      team:           teamR.rows,
      legal_consents: consentsR.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GDPR — self-service account deletion (cascades via FK ON DELETE CASCADE)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/gdpr/account', requireOwner, async (req, res) => {
  const { confirm_email } = req.body;
  if (confirm_email !== req.user.email)
    return res.status(400).json({ error: 'confirm_email must match your account email exactly.' });
  try {
    await writeAudit({ tenant_id: req.user.id, actor_id: req.user.id, actor_email: req.user.email,
      action: 'gdpr_account_self_deleted', ip: clientIp(req) });
    await pool.query('DELETE FROM tenants WHERE id=$1', [req.user.id]);
    res.json({ success: true, message: 'Account and all data permanently deleted.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Deletion failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// JOBS — direct send + logs + DLQ
// ─────────────────────────────────────────────────────────────────────────────
router.get('/jobs', requireTenant, async (req, res) => {
  try { res.json(await tenantService.getJobLogs(req.user.id)); }
  catch (err) { res.status(500).json({ error: 'Failed to load jobs' }); }
});

router.post('/jobs', requireTenant, async (req, res) => {
  const { channel, recipient, message } = req.body;
  if (!channel || !recipient || !message)
    return res.status(400).json({ error: 'Missing fields: channel, recipient, message' });
  try {
    const result = await tenantService.createJobWithLimitCheck(req.user.id, channel, recipient, message);
    res.json({ success: true, job_id: result.job_id });
  } catch (err) {
    const status = ['LIMIT_EXCEEDED','CHANNEL_NOT_ENABLED'].includes(err.code) ? 403
                 : err.code === 'TENANT_NOT_FOUND' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/jobs/bulk-upload', requireTenant, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file required' });
  try {
    const summary = await tenantService.bulkUploadJobsFromCsv(req.user.id, req.file.path);
    res.json(summary);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Bulk upload failed' }); }
});

// DLQ
router.get('/jobs/dlq', requireTenant, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50'), 200);
    const offset = Math.max(parseInt(req.query.offset || '0'),  0);
    const [jobs, total] = await Promise.all([
      pool.query(
        `SELECT id, channel, recipient, status, retry_count, last_error, created_at, scheduled_at
         FROM jobs WHERE tenant_id=$1 AND status='permanent_failed'
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) AS cnt FROM jobs WHERE tenant_id=$1 AND status='permanent_failed'`,
        [req.user.id]
      ),
    ]);
    res.json({ jobs: jobs.rows, total: parseInt(total.rows[0].cnt) });
  } catch (err) { res.status(500).json({ error: 'Failed to load DLQ' }); }
});

router.post('/jobs/:id/retry', requireTenant, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status FROM jobs WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    if (rows[0].status !== 'permanent_failed')
      return res.status(409).json({ error: 'Only permanent_failed jobs can be retried' });
    await pool.query(
      `UPDATE jobs SET status='pending', retry_count=0, last_error=NULL, scheduled_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/jobs/dlq/retry-all', requireTenant, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE jobs SET status='pending', retry_count=0, last_error=NULL, scheduled_at=NOW()
       WHERE tenant_id=$1 AND status='permanent_failed'`,
      [req.user.id]
    );
    res.json({ retried: rowCount });
  } catch (err) { res.status(500).json({ error: 'Retry-all failed' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMERS — search + edit + delete
// ─────────────────────────────────────────────────────────────────────────────
router.get('/customers', requireTenant, async (req, res) => {
  try {
    const q      = (req.query.q || '').trim();
    const limit  = Math.min(parseInt(req.query.limit  || '50'), 200);
    const offset = Math.max(parseInt(req.query.offset || '0'),  0);
    const pattern = q ? `%${q}%` : null;
    const where   = pattern
      ? `AND (customer_id ILIKE $3 OR first_name ILIKE $3 OR last_name ILIKE $3 OR email ILIKE $3 OR phone ILIKE $3)`
      : '';
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT id, customer_id, first_name, last_name, email, phone, expiry_date, created_at
         FROM customers WHERE tenant_id=$1 ${where}
         ORDER BY expiry_date ASC NULLS LAST LIMIT $2`,
        pattern ? [req.user.id, limit, pattern] : [req.user.id, limit]
      ),
      pool.query(
        `SELECT COUNT(*) AS cnt FROM customers WHERE tenant_id=$1 ${where}`,
        pattern ? [req.user.id, pattern] : [req.user.id]
      ),
    ]);
    res.json({ customers: rows.rows, total: parseInt(total.rows[0].cnt), offset });
  } catch (err) { res.status(500).json({ error: 'Failed to search customers' }); }
});

router.put('/customers/:id', requireTenant, async (req, res) => {
  const allowed = ['first_name','last_name','email','phone','expiry_date'];
  const sets = [], vals = [req.user.id, req.params.id];
  let i = 3;
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) { sets.push(`${k}=$${i++}`); vals.push(v || null); }
  }
  if (!sets.length) return res.status(400).json({ error: 'No valid fields provided' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE customers SET ${sets.join(',')} WHERE tenant_id=$1 AND id=$2`, vals
    );
    if (!rowCount) return res.status(404).json({ error: 'Customer not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/customers/:id', requireTenant, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM customers WHERE tenant_id=$1 AND id=$2', [req.user.id, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Customer not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CSV EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
function csvEscape(v) {
  const s = String(v ?? '');
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/export/customers.csv', requireTenant, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT customer_id, first_name, last_name, email, phone, expiry_date::text, created_at
       FROM customers WHERE tenant_id=$1 ORDER BY expiry_date ASC NULLS LAST`,
      [req.user.id]
    );
    const header = 'customer_id,first_name,last_name,email,phone,expiry_date,created_at';
    const csv = [header, ...rows.map(r =>
      [r.customer_id, r.first_name, r.last_name, r.email, r.phone, r.expiry_date, r.created_at].map(csvEscape).join(',')
    )].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="customers.csv"');
    res.send(csv);
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});

router.get('/export/jobs.csv', requireTenant, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, channel, recipient, status, delivery_status, scheduled_at, created_at, last_error
       FROM jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 10000`,
      [req.user.id]
    );
    const header = 'id,channel,recipient,status,delivery_status,scheduled_at,created_at,last_error';
    const csv = [header, ...rows.map(r =>
      [r.id, r.channel, r.recipient, r.status, r.delivery_status, r.scheduled_at, r.created_at, r.last_error].map(csvEscape).join(',')
    )].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="job-history.csv"');
    res.send(csv);
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// BILLING — purchase requests + history + upcoming expiries + onboarding
// ─────────────────────────────────────────────────────────────────────────────
router.post('/tenant/purchase', requireTenant, async (req, res) => {
  const { plan_id, payment_method } = req.body;
  if (!plan_id || !payment_method) return res.status(400).json({ error: 'Missing plan_id or payment_method' });
  try {
    const result = await paymentService.createPurchaseRequest(req.user.id, plan_id, payment_method);
    writeAudit({ tenant_id: req.user.id, actor_id: req.user.id, actor_email: req.user.email,
      action: 'purchase_requested', meta: { plan_id, amount: result.amount }, ip: clientIp(req) });
    res.json({
      success: true, request_id: result.request_id, amount: result.amount,
      message: 'Purchase request submitted. We will activate your plan once payment is confirmed.',
    });
  } catch (err) {
    const status = ['INVALID_PLAN','INVALID_PAYMENT_METHOD'].includes(err.code) ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get('/tenant/purchase-history', requireTenant, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, plan_id, amount, payment_method, status, created_at, approved_at, notes
       FROM purchase_requests WHERE tenant_id=$1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load purchase history' }); }
});

router.get('/tenant/upcoming-expiries', requireTenant, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,
              COALESCE(first_name,'') || ' ' || COALESCE(last_name,'') AS customer_name,
              expiry_date, (expiry_date - CURRENT_DATE) AS days_left
       FROM customers
       WHERE tenant_id=$1
         AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
       ORDER BY expiry_date`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load expiries' }); }
});

router.post('/tenant/onboarding-complete', requireTenant, async (req, res) => {
  try {
    await pool.query('UPDATE tenants SET onboarding_complete=true WHERE id=$1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
