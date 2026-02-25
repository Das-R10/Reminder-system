require('dotenv').config();

const express     = require('express');
const multer      = require('multer');
const path        = require('path');
const { parse }   = require('csv-parse/sync');
const jwt         = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const { initDB, pool, insertCustomer, createRule, markJobSent } = require('./db');
const authService         = require('./services/authService');
const notificationService = require('./services/notificationService');
const schedulerService    = require('./services/schedulerService');
const jobExecutorService  = require('./services/jobExecutorService');
const paymentService      = require('./services/paymentService');
const { getAllPlans }      = require('./plans');

const JWT_SECRET   = process.env.JWT_SECRET;
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const upload       = multer({ storage: multer.memoryStorage() });
const PORT         = process.env.PORT || 3000;

if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET missing in environment');
  process.exit(1);
}

// ── Auth middleware ────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  const token = header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Invalid token format' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
async function start() {
  await initDB();

  const app = express();
  app.use(express.json());
  app.use('/',      express.static(path.join(__dirname, 'public')));
  app.use('/admin', express.static(path.join(__dirname, 'admin')));

  // Tenant routes
  const tenantRoutes = require('./routes/tenant');
  app.use('/api', tenantRoutes);

  // ── Public: plans list ───────────────────────────────────────────────────────
  app.get('/api/plans', (req, res) => res.json(getAllPlans()));

  // ── Auth ─────────────────────────────────────────────────────────────────────
  app.post('/api/signup', async (req, res) => {
    const { company_name, email, password } = req.body;
    if (!company_name || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    try {
      await authService.signup(company_name, email, password);
      res.json({ success: true });
    } catch (err) {
      const msg = err.message?.includes('unique') ? 'Email already registered' : 'Signup failed';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
      const result = await authService.login(email, password);
      res.json(result);
    } catch (err) {
      const msg = err.code === 'USER_NOT_FOUND' ? 'User not found' : 'Invalid password';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/google-login', async (req, res) => {
    try {
      const { token } = req.body;
      const ticket  = await googleClient.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID
      });
      const payload = ticket.getPayload();
      const tenant  = await authService.findOrCreateTenant(payload.email, payload.name);
      const jwtToken = authService.issueToken(tenant);
      res.json({ token: jwtToken, role: tenant.role, company_name: tenant.name });
    } catch (err) {
      console.error(err);
      res.status(401).json({ error: 'Invalid Google token' });
    }
  });

  // ── Customer upload (CSV) ────────────────────────────────────────────────────
  app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'CSV file required' });

      const csvText = req.file.buffer.toString('utf-8');
      const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });

      let inserted = 0, skipped = 0;
      for (const row of records) {
        if (!row.customer_id || !row.expiry_date) { skipped++; continue; }
        await insertCustomer({
          tenant_id:   req.user.id,
          customer_id: row.customer_id,
          first_name:  row.first_name  || null,
          last_name:   row.last_name   || null,
          email:       row.email       || null,
          phone:       row.phone       || null,
          expiry_date: row.expiry_date,
          meta:        row
        });
        inserted++;
      }
      res.json({ success: true, inserted, skipped });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Rules ────────────────────────────────────────────────────────────────────
  app.post('/api/rules', auth, async (req, res) => {
    const { name, lead_days, channels, template } = req.body;
    if (!lead_days || !channels || !template) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
      const rule = await createRule({
        tenant_id: req.user.id,
        name: name || 'Expiry Reminder',
        lead_days,
        channels,
        template
      });
      res.json({ success: true, rule });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/rules', auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM rules WHERE tenant_id=$1 ORDER BY created_at DESC',
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Message history ───────────────────────────────────────────────────────────
  app.get('/api/history', auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, customer_id, channel, status, scheduled_at, recipient
         FROM jobs WHERE tenant_id=$1 ORDER BY id DESC LIMIT 100`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to load history' });
    }
  });

  // ── Test send ─────────────────────────────────────────────────────────────────
  app.post('/api/test-send', auth, async (req, res) => {
    const { customer_id, channel } = req.body;
    if (!customer_id || !channel) {
      return res.status(400).json({ error: 'Missing customer_id or channel' });
    }
    try {
      const result = await pool.query(
        'SELECT * FROM customers WHERE tenant_id=$1 AND customer_id=$2',
        [req.user.id, customer_id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Customer not found' });

      const customer = result.rows[0];
      const jobResult = await pool.query(
        `INSERT INTO jobs (tenant_id, customer_id, channel, status, scheduled_at, recipient)
         VALUES ($1,$2,$3,'pending',NOW(),$4) RETURNING *`,
        [req.user.id, customer.id, channel, customer.email || customer.phone]
      );
      const job = jobResult.rows[0];

      const fakeJob = {
        channel,
        email:      customer.email,
        phone:      customer.phone,
        first_name: customer.first_name,
        last_name:  customer.last_name,
        expiry_date: customer.expiry_date,
        template:   'Hi {{first_name}}, your subscription expires on {{expiry_date}}. Please renew!'
      };

      const providerId = await notificationService.sendNotification(fakeJob);
      await markJobSent(job.id, providerId);

      res.json({ success: true, provider_id: providerId });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Send all pending now (manual trigger) ─────────────────────────────────────
  app.post('/api/send-now', auth, async (req, res) => {
    try {
      await jobExecutorService.runJobExecutor();
      res.json({ success: true, message: 'Job executor triggered' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin: stats ──────────────────────────────────────────────────────────────
  app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
    try {
      const [tenants, jobs, sent, failed, pendingPayments] = await Promise.all([
        pool.query("SELECT COUNT(*) FROM tenants WHERE role='user'"),
        pool.query('SELECT COUNT(*) FROM jobs'),
        pool.query("SELECT COUNT(*) FROM jobs WHERE status='sent'"),
        pool.query("SELECT COUNT(*) FROM jobs WHERE status IN ('failed','permanent_failed')"),
        pool.query("SELECT COUNT(*) FROM purchase_requests WHERE status='pending'")
      ]);
      res.json({
        total_tenants:    tenants.rows[0].count,
        total_jobs:       jobs.rows[0].count,
        sent_jobs:        sent.rows[0].count,
        failed_jobs:      failed.rows[0].count,
        pending_payments: pendingPayments.rows[0].count
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin: list all tenants ────────────────────────────────────────────────────
  app.get('/api/admin/tenants', auth, adminOnly, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, name, email, role, active_plans, created_at FROM tenants ORDER BY created_at DESC'
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin: purchase requests ──────────────────────────────────────────────────
  app.get('/api/admin/purchases', auth, adminOnly, async (req, res) => {
    try {
      const rows = await paymentService.getAllPurchaseRequests(req.query.status || null);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/purchases/:id/approve', auth, adminOnly, async (req, res) => {
    try {
      const result = await paymentService.approvePurchaseRequest(
        parseInt(req.params.id), req.user.id
      );
      res.json({ success: true, ...result });
    } catch (err) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'ALREADY_PROCESSED' ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  app.post('/api/admin/purchases/:id/reject', auth, adminOnly, async (req, res) => {
    try {
      await paymentService.rejectPurchaseRequest(
        parseInt(req.params.id), req.user.id, req.body.notes || ''
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin: manually activate plan for a tenant ────────────────────────────────
  app.post('/api/admin/tenants/:id/activate-plan', auth, adminOnly, async (req, res) => {
    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
    try {
      await pool.query(
        `UPDATE tenants
         SET active_plans = (
           SELECT jsonb_agg(DISTINCT val)
           FROM (
             SELECT jsonb_array_elements_text(COALESCE(active_plans,'[]'::jsonb)) AS val
             UNION ALL SELECT $2::text
           ) sub
         )
         WHERE id=$1`,
        [req.params.id, plan_id]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Health ────────────────────────────────────────────────────────────────────
  app.get('/health', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT now()');
      res.json({ ok: true, time: rows[0].now });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Start ──────────────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`🚀 Server listening on http://localhost:${PORT}`);

    // Scheduler: check every 24h for new jobs to create
    schedulerService.runScheduler();
    setInterval(schedulerService.runScheduler, 24 * 60 * 60 * 1000);

    // Executor: send pending jobs every 60s
    jobExecutorService.runJobExecutor();
    setInterval(jobExecutorService.runJobExecutor, 60 * 1000);
  });
}

start().catch(err => {
  console.error('Failed to start app:', err);
  process.exit(1);
});