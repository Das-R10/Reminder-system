// db.js
require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('ERROR: DATABASE_URL not set in environment');
  process.exit(1);
}

const pool = new Pool({ connectionString });

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Tenants ────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id           SERIAL PRIMARY KEY,
        name         TEXT NOT NULL,
        email        TEXT UNIQUE,
        password     TEXT,
        role         TEXT DEFAULT 'user',
        active_plans JSONB DEFAULT '[]'::jsonb,  -- e.g. ["sms_starter","whatsapp_starter"]
        created_at   TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Migration: add new columns if they don't exist
    await client.query(`
      ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS role         TEXT DEFAULT 'user',
      ADD COLUMN IF NOT EXISTS active_plans JSONB DEFAULT '[]'::jsonb;
    `);

    // ── Per-channel usage counters ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS channel_usage (
        id           SERIAL PRIMARY KEY,
        tenant_id    INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        channel      TEXT NOT NULL,         -- email | sms | whatsapp
        month        TEXT NOT NULL,         -- YYYY-MM
        used         INT DEFAULT 0,
        quota        INT DEFAULT 0,
        UNIQUE (tenant_id, channel, month)
      );
    `);

    // ── Customers ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id           SERIAL PRIMARY KEY,
        tenant_id    INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        customer_id  TEXT NOT NULL,
        first_name   TEXT,
        last_name    TEXT,
        email        TEXT,
        phone        TEXT,
        expiry_date  DATE,
        meta         JSONB DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ DEFAULT now(),
        UNIQUE (tenant_id, customer_id)
      );
    `);

    // ── Rules ──────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS rules (
        id           SERIAL PRIMARY KEY,
        tenant_id    INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        lead_days    JSONB DEFAULT '[]'::jsonb,
        channels     JSONB DEFAULT '[]'::jsonb,
        template     TEXT,
        is_active    BOOLEAN DEFAULT TRUE,
        created_at   TIMESTAMPTZ DEFAULT now()
      );
    `);

    // ── Jobs ───────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id              SERIAL PRIMARY KEY,
        tenant_id       INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        customer_id     INT REFERENCES customers(id) ON DELETE CASCADE,
        rule_id         INT REFERENCES rules(id) ON DELETE SET NULL,
        channel         TEXT,
        recipient       TEXT,
        message         TEXT,
        scheduled_at    TIMESTAMPTZ,
        status          TEXT DEFAULT 'pending',
        attempts        INT DEFAULT 0,
        retry_count     INT DEFAULT 0,
        last_error      TEXT,
        provider_msg_id TEXT,
        created_at      TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS recipient  TEXT,
      ADD COLUMN IF NOT EXISTS message    TEXT,
      ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_unique_idx
      ON jobs (tenant_id, customer_id, rule_id, channel, scheduled_at)
      WHERE customer_id IS NOT NULL AND rule_id IS NOT NULL;
    `);

    // ── Purchase requests ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_requests (
        id             SERIAL PRIMARY KEY,
        tenant_id      INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        plan_id        TEXT NOT NULL,
        amount         INT NOT NULL,
        payment_method TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',   -- pending | approved | rejected
        approved_by    INT REFERENCES tenants(id),
        approved_at    TIMESTAMPTZ,
        notes          TEXT,
        created_at     TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Seed demo tenant
    await client.query(`
      INSERT INTO tenants (name, email, role)
      SELECT 'demo', 'demo@demo.com', 'user'
      WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE email = 'demo@demo.com');
    `);

    // Seed admin tenant (set a real password via env or manually)
    await client.query(`
      INSERT INTO tenants (name, email, role)
      SELECT 'Admin', 'admin@expirynotifier.com', 'admin'
      WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE email = 'admin@expirynotifier.com');
    `);

    await client.query('COMMIT');
    console.log('✅ Database initialized / migrations applied.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error running migrations:', err);
    throw err;
  } finally {
    client.release();
  }
}

// ── Customer helpers ───────────────────────────────────────────────────────────
async function insertCustomer(customer) {
  const { tenant_id, customer_id, first_name, last_name, email, phone, expiry_date, meta } = customer;
  await pool.query(
    `INSERT INTO customers (tenant_id, customer_id, first_name, last_name, email, phone, expiry_date, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, customer_id)
     DO UPDATE SET
       first_name  = EXCLUDED.first_name,
       last_name   = EXCLUDED.last_name,
       email       = EXCLUDED.email,
       phone       = EXCLUDED.phone,
       expiry_date = EXCLUDED.expiry_date,
       meta        = EXCLUDED.meta`,
    [tenant_id, customer_id, first_name, last_name, email, phone, expiry_date, meta || {}]
  );
}

// ── Rule helpers ───────────────────────────────────────────────────────────────
async function createRule(rule) {
  const { tenant_id, name, lead_days, channels, template } = rule;
  const { rows } = await pool.query(
    `INSERT INTO rules (tenant_id, name, lead_days, channels, template)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)
     RETURNING *`,
    [tenant_id, name, JSON.stringify(lead_days), JSON.stringify(channels), template]
  );
  return rows[0];
}

async function getActiveRules() {
  const { rows } = await pool.query(`SELECT * FROM rules WHERE is_active = true`);
  return rows;
}

// ── Job helpers ────────────────────────────────────────────────────────────────
async function jobExists(tenant_id, customer_id, rule_id, channel, scheduled_at) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM jobs WHERE tenant_id=$1 AND customer_id=$2 AND rule_id=$3
     AND channel=$4 AND scheduled_at=$5`,
    [tenant_id, customer_id, rule_id, channel, scheduled_at]
  );
  return rowCount > 0;
}

async function createJob(job) {
  const { tenant_id, customer_id, rule_id, channel, scheduled_at, recipient } = job;
  await pool.query(
    `INSERT INTO jobs (tenant_id, customer_id, rule_id, channel, scheduled_at, recipient)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenant_id, customer_id, rule_id, channel, scheduled_at, recipient || null]
  );
}

async function getPendingJobs(limit = 50) {
  const { rows } = await pool.query(
    `WITH claimed AS (
       UPDATE jobs SET status = 'queued'
       WHERE id IN (
         SELECT id FROM jobs
         WHERE status = 'pending' AND scheduled_at <= NOW()
         ORDER BY scheduled_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id
     )
     SELECT j.*, c.email, c.phone, c.first_name, c.last_name, c.expiry_date, r.template
     FROM jobs j
     JOIN claimed ON claimed.id = j.id
     LEFT JOIN customers c ON c.id = j.customer_id
     LEFT JOIN rules r ON r.id = j.rule_id`,
    [limit]
  );
  return rows;
}

async function markJobSent(job_id, provider_msg_id) {
  await pool.query(
    `UPDATE jobs SET status='sent', provider_msg_id=$2 WHERE id=$1`,
    [job_id, provider_msg_id]
  );
}

async function markJobFailed(job_id, error) {
  await pool.query(
    `UPDATE jobs SET status='permanent_failed', attempts=attempts+1, last_error=$2 WHERE id=$1`,
    [job_id, error]
  );
}

async function rescheduleJob(job_id, delayMinutes, error) {
  await pool.query(
    `UPDATE jobs
     SET scheduled_at = NOW() + ($2 * INTERVAL '1 minute'),
         retry_count  = COALESCE(retry_count, 0) + 1,
         attempts     = attempts + 1,
         status       = 'pending',
         last_error   = $3
     WHERE id = $1`,
    [job_id, delayMinutes, error]
  );
}

// ── Channel usage helpers ──────────────────────────────────────────────────────
function currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

async function incrementChannelUsage(tenant_id, channel, quota) {
  const month = currentMonth();
  await pool.query(
    `INSERT INTO channel_usage (tenant_id, channel, month, used, quota)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (tenant_id, channel, month)
     DO UPDATE SET used = channel_usage.used + 1,
                   quota = EXCLUDED.quota`,
    [tenant_id, channel, month, quota]
  );
}

async function getChannelUsage(tenant_id) {
  const month = currentMonth();
  const { rows } = await pool.query(
    `SELECT channel, used, quota FROM channel_usage
     WHERE tenant_id = $1 AND month = $2`,
    [tenant_id, month]
  );
  return rows;
}

module.exports = {
  pool,
  initDB,
  insertCustomer,
  createRule,
  getActiveRules,
  jobExists,
  createJob,
  getPendingJobs,
  markJobSent,
  markJobFailed,
  rescheduleJob,
  incrementChannelUsage,
  getChannelUsage,
  currentMonth
};