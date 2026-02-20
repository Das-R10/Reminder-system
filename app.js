
require("dotenv").config(); // <-- load env as early as possible

const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { OAuth2Client } = require("google-auth-library");
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("❌ JWT_SECRET missing in environment");
  process.exit(1);
}
const express = require("express");

const {
  initDB,
  pool,
  insertCustomer,
  createRule,
  markJobSent
} = require('./db');

const authService = require('./services/authService');
const notificationService = require('./services/notificationService');
const schedulerService = require('./services/schedulerService');
const jobExecutorService = require('./services/jobExecutorService');

const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "No token" });

  const token = header.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Invalid token format" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    return res.status(401).json({ error: "Invalid token" });
  }
}



function adminOnly(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

// Middleware to check admin
async function requireAdmin(req, res, next) {
  try {
    const tenant_id = req.headers['x-tenant-id'];

    if (!tenant_id) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const result = await pool.query(
      "SELECT role FROM tenants WHERE tenant_id = $1",
      [tenant_id]
    );

    if (!result.rows.length || result.rows[0].role !== 'admin') {
      return res.status(403).json({ error: "Access denied" });
    }

    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Admin check failed" });
  }
}

async function start() {
  await initDB();
  
  const { rows } = await pool.query('SELECT now(), inet_server_addr()');
  console.log('🧠 Connected DB info:', rows[0]);



  const app = express();
  app.use(express.json());
  const path = require('path');
  app.use("/", express.static(path.join(__dirname, "public")));
  app.use("/admin", express.static(path.join(__dirname, "admin")));
  app.use(express.json());
  const tenantRoutes = require("./routes/tenant");
  app.use("/api", tenantRoutes);
  app.use("/api", tenantRoutes);// auth required so req.user exists
  // Also expose webhook without auth (it uses signature)



  app.post("/api/google-login", async (req, res) => {
    try {
      const { token } = req.body;

      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID
      });

      const payload = ticket.getPayload();
      const email = payload.email;
      const name = payload.name;

      const tenant = await authService.findOrCreateTenant(email, name);
      const jwtToken = authService.issueToken(tenant);

      res.json({
        token: jwtToken,
        role: tenant.role || 'user',
        company_name: tenant.name
      });
    } catch (err) {
      console.error(err);
      res.status(401).json({ error: "Invalid Google token" });
    }
  });


  

  app.get("/api/history", auth, async (req, res) => {
    try {
      const tenant_id = req.user.id;

      const result = await pool.query(
        `SELECT id, customer_id, channel, status, scheduled_at
        FROM jobs
        WHERE tenant_id = $1
        ORDER BY id DESC`,
        [tenant_id]
      );

      res.json(result.rows);

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load history" });
    }
  });


    


  // Admin stats
    app.get("/api/admin/stats", auth, adminOnly, async (req, res) => {
      const tenants = await pool.query("SELECT COUNT(*) FROM tenants WHERE role='user'");
      const jobs = await pool.query("SELECT COUNT(*) FROM jobs");
      const sent = await pool.query("SELECT COUNT(*) FROM jobs WHERE status='sent'");
      const failed = await pool.query(
        "SELECT COUNT(*) FROM jobs WHERE status IN ('failed','permanent_failed')"
      );

      res.json({
        total_tenants: tenants.rows[0].count,
        total_jobs: jobs.rows[0].count,
        sent_jobs: sent.rows[0].count,
        failed_jobs: failed.rows[0].count
      });
    });

    app.get("/api/admin/tenants", auth, adminOnly, async (req, res) => {
      const result = await pool.query(
        "SELECT id, name, email, role, created_at FROM tenants"
      );
      res.json(result.rows);
    });




    


  app.get('/health', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT now()');
      res.json({ ok: true, time: rows[0].now });
    } catch (err) {
      console.error('/health error', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
    try {
      const tenant_id = req.user.id;

      if (!req.file) {
        return res.status(400).json({ error: 'CSV file required' });
      }

      const csvText = req.file.buffer.toString('utf-8');
      const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });

      let inserted = 0;

      for (const row of records) {
        if (!row.customer_id || !row.expiry_date) continue;

        await insertCustomer({
          tenant_id,
          customer_id: row.customer_id,
          first_name: row.first_name || null,
          last_name: row.last_name || null,
          email: row.email || null,
          phone: row.phone || null,
          expiry_date: row.expiry_date,
          meta: row,
        });

        inserted++;
      }

      res.json({ success: true, inserted });

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });



  app.post("/api/signup", async (req, res) => {
    const { company_name, email, password } = req.body;

    try {
      await authService.signup(company_name, email, password);
      res.json({ success: true });
    } catch (err) {
      console.error("Signup error:", err);
      res.status(500).json({ error: "Signup failed" });
    }
  });




  app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;

    try {
      const result = await authService.login(email, password);
      res.json(result);
    } catch (err) {
      const message = err.code === 'USER_NOT_FOUND' ? 'User not found' : 'Invalid password';
      return res.status(400).json({ error: message });
    }
  });




  app.post('/api/rules', auth, async (req, res) => {
    try {
      const tenant_id = req.user.id;
      const { name, lead_days, channels, template } = req.body;

      if (!lead_days || !channels || !template) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const rule = await createRule({
        tenant_id,
        name: name || "Expiry Reminder",
        lead_days,
        channels,
        template
      });

      res.json({ success: true, rule });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/test-send", auth, async (req, res) => {
    try {
      const tenant_id = req.user.id;
      const { customer_id, channel } = req.body;

      if (!customer_id || !channel) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const result = await pool.query(
        `SELECT * FROM customers WHERE tenant_id=$1 AND customer_id=$2`,
        [tenant_id, customer_id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const customer = result.rows[0];

      // 1️⃣ Create job entry
      const jobResult = await pool.query(
        `INSERT INTO jobs
        (tenant_id, customer_id, channel, status, scheduled_at)
        VALUES ($1, $2, $3, 'pending', NOW())
        RETURNING *`,
        [tenant_id, customer.id, channel]
      );

      const job = jobResult.rows[0];

      // 2️⃣ Send notification
      const fakeJob = {
        channel,
        email: customer.email,
        phone: customer.phone,
        first_name: customer.first_name,
        expiry_date: customer.expiry_date,
        template: "Test reminder for {{first_name}} expiring on {{expiry_date}}"
      };

      const providerId = await notificationService.sendNotification(fakeJob);

      // 3️⃣ Mark as sent
      await markJobSent(job.id, providerId);

      res.json({ success: true, providerId });

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });


  app.get("/api/tenant/upcoming-expiries", auth, async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const tenant_id = req.user.id;// depends on your auth middleware

      const { rows } = await pool.query(`
        SELECT 
          id,
          first_name || ' ' || last_name AS customer_name,
          expiry_date,
          expiry_date - CURRENT_DATE AS days_left
        FROM customers
        WHERE tenant_id = $1
          AND expiry_date BETWEEN CURRENT_DATE 
          AND CURRENT_DATE + INTERVAL '30 days'
        ORDER BY expiry_date
      `, [tenant_id]);

      res.json(rows);

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load expiries" });
    }
  });

  app.get('/', (req, res) => res.send('Expiry Notifier — running.'));

  app.listen(PORT, () => {
    console.log(`🚀 Server listening on http://localhost:${PORT}`);
    schedulerService.runScheduler();
    setInterval(schedulerService.runScheduler, 24 * 60 * 60 * 1000);

    jobExecutorService.runJobExecutor();
    setInterval(jobExecutorService.runJobExecutor, 60 * 1000);
  });
}



start().catch((err) => {
  console.error('Failed to start app:', err);
  process.exit(1);
});
