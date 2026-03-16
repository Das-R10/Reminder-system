// routes/auth.js — public endpoints + tenant actions that were in app.js
const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const { parse }  = require('csv-parse/sync');
const { OAuth2Client } = require('google-auth-library');

const { pool, insertCustomer, createRule, markJobSent, writeAudit } = require('../db');
const authService         = require('../services/authService');
const notificationService = require('../services/notificationService');
const jobExecutorService  = require('../services/jobExecutorService');
const { requireTenant }   = require('../middleware/auth');
const { getAllPlans }      = require('../plans');

const upload       = multer({ storage: multer.memoryStorage() });
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const clientIp     = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;

// ── Plans (public) ─────────────────────────────────────────────────────────────
router.get('/plans', (_req, res) => res.json(getAllPlans()));

// ── Signup — ToS gate ──────────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  const { company_name, email, password, tos_accepted } = req.body;
  if (!company_name || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (!tos_accepted)
    return res.status(400).json({ error: 'You must accept the Terms of Service and Privacy Policy to sign up.' });

  try {
    const tenant = await authService.signup(company_name, email, password);
    const ip = clientIp(req);

    // Record legal consent
    await pool.query(
      `INSERT INTO legal_consents (tenant_id, tos_version, pp_version, ip) VALUES ($1,'1.0','1.0',$2)`,
      [tenant.id, ip]
    );
    await writeAudit({ tenant_id: tenant.id, actor_id: tenant.id, actor_email: email,
      action: 'signup', meta: { company_name }, ip });

    res.json({ success: true });
  } catch (err) {
    const msg = err.message?.includes('unique') ? 'Email already registered' : 'Signup failed';
    res.status(400).json({ error: msg });
  }
});

// ── Login ──────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await authService.login(email, password);
    // fire-and-forget audit
    pool.query('SELECT id FROM tenants WHERE email=$1', [email])
      .then(({ rows }) => rows[0] && writeAudit({
        tenant_id: rows[0].id, actor_id: rows[0].id, actor_email: email,
        action: 'login', ip: clientIp(req)
      }));
    res.json(result);
  } catch (err) {
    const msg = err.code === 'USER_NOT_FOUND' ? 'User not found' : 'Invalid password';
    res.status(400).json({ error: msg });
  }
});

// ── Google OAuth Login ─────────────────────────────────────────────────────────
router.post('/google-login', async (req, res) => {
  try {
    const { token } = req.body;
    const ticket    = await googleClient.verifyIdToken({ idToken: token, audience: process.env.GOOGLE_CLIENT_ID });
    const payload   = ticket.getPayload();
    const tenant    = await authService.findOrCreateTenant(payload.email, payload.name);
    res.json({ token: authService.issueToken(tenant), role: tenant.role, company_name: tenant.name });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

// ── Customer CSV upload ────────────────────────────────────────────────────────
router.post('/upload', requireTenant, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'CSV file required' });
    const records = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true });
    let inserted = 0, skipped = 0;
    for (const row of records) {
      if (!row.customer_id || !row.expiry_date) { skipped++; continue; }
      await insertCustomer({
        tenant_id: req.user.id, customer_id: row.customer_id,
        first_name: row.first_name || null, last_name: row.last_name || null,
        email: row.email || null, phone: row.phone || null,
        expiry_date: row.expiry_date, meta: row,
      });
      inserted++;
    }
    writeAudit({ tenant_id: req.user.id, actor_id: req.user.id, actor_email: req.user.email,
      action: 'customers_uploaded', meta: { inserted, skipped }, ip: clientIp(req) });
    res.json({ success: true, inserted, skipped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Rules ──────────────────────────────────────────────────────────────────────
router.post('/rules', requireTenant, async (req, res) => {
  const { name, lead_days, channels, template } = req.body;
  if (!lead_days || !channels || !template)
    return res.status(400).json({ error: 'Missing required fields' });
  try {
    const rule = await createRule({ tenant_id: req.user.id, name: name || 'Expiry Reminder', lead_days, channels, template });
    writeAudit({ tenant_id: req.user.id, actor_id: req.user.id, actor_email: req.user.email,
      action: 'rule_created', target_type: 'rule', target_id: rule.id, meta: { name: rule.name }, ip: clientIp(req) });
    res.json({ success: true, rule });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/rules', requireTenant, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM rules WHERE tenant_id=$1 ORDER BY created_at DESC', [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/rules/:id', requireTenant, async (req, res) => {
  try {
    await pool.query(`UPDATE rules SET is_active=false WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.id]);
    writeAudit({ tenant_id: req.user.id, actor_id: req.user.id, actor_email: req.user.email,
      action: 'rule_deactivated', target_type: 'rule', target_id: req.params.id, ip: clientIp(req) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Message history ────────────────────────────────────────────────────────────
router.get('/history', requireTenant, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, customer_id, channel, status, delivery_status, scheduled_at, recipient
       FROM jobs WHERE tenant_id=$1 ORDER BY id DESC LIMIT 100`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load history' }); }
});

// ── Test send ──────────────────────────────────────────────────────────────────
router.post('/test-send', requireTenant, async (req, res) => {
  const { customer_id, channel } = req.body;
  if (!customer_id || !channel) return res.status(400).json({ error: 'Missing customer_id or channel' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM customers WHERE tenant_id=$1 AND customer_id=$2', [req.user.id, customer_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found' });
    const customer = rows[0];
    const { rows: jr } = await pool.query(
      `INSERT INTO jobs (tenant_id, customer_id, channel, status, scheduled_at, recipient)
       VALUES ($1,$2,$3,'pending',NOW(),$4) RETURNING *`,
      [req.user.id, customer.id, channel, customer.email || customer.phone]
    );
    const job = jr[0];
    const fakeJob = { channel, email: customer.email, phone: customer.phone,
      first_name: customer.first_name, last_name: customer.last_name, expiry_date: customer.expiry_date,
      template: 'Hi {{first_name}}, your subscription expires on {{expiry_date}}. Please renew!' };
    const providerId = await notificationService.sendNotification(fakeJob);
    await markJobSent(job.id, providerId);
    res.json({ success: true, provider_id: providerId });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Manual executor trigger ────────────────────────────────────────────────────
router.post('/send-now', requireTenant, async (req, res) => {
  try {
    await jobExecutorService.runJobExecutor();
    res.json({ success: true, message: 'Job executor triggered' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health ─────────────────────────────────────────────────────────────────────
router.get('/health', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT now()');
    res.json({ ok: true, time: rows[0].now });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;
