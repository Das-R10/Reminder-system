// db.js — Phase 5
require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }

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
        active_plans JSONB DEFAULT '[]'::jsonb,
        created_at   TIMESTAMPTZ DEFAULT now()
      );
    `);
    await client.query(`
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS role         TEXT DEFAULT 'user',
        ADD COLUMN IF NOT EXISTS active_plans JSONB DEFAULT '[]'::jsonb;
    `);

    // ── Team members — multi-user per tenant org ───────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id         SERIAL PRIMARY KEY,
        org_id     INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id    INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        team_role  TEXT NOT NULL DEFAULT 'member',   -- owner | member
        invited_by INT REFERENCES tenants(id),
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (org_id, user_id)
      );
    `);

    // ── Audit log ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          BIGSERIAL PRIMARY KEY,
        tenant_id   INT REFERENCES tenants(id) ON DELETE SET NULL,
        actor_id    INT REFERENCES tenants(id) ON DELETE SET NULL,
        actor_email TEXT,
        action      TEXT NOT NULL,
        target_type TEXT,
        target_id   TEXT,
        meta        JSONB DEFAULT '{}'::jsonb,
        ip          TEXT,
        created_at  TIMESTAMPTZ DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS audit_log_tenant_idx
        ON audit_log (tenant_id, created_at DESC);
    `);

    // ── Legal consents ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS legal_consents (
        id          SERIAL PRIMARY KEY,
        tenant_id   INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        tos_version TEXT NOT NULL DEFAULT '1.0',
        pp_version  TEXT NOT NULL DEFAULT '1.0',
        accepted_at TIMESTAMPTZ DEFAULT now(),
        ip          TEXT
      );
    `);

    // ── Per-channel usage counters ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS channel_usage (
        id        SERIAL PRIMARY KEY,
        tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        channel   TEXT NOT NULL,
        month     TEXT NOT NULL,
        used      INT DEFAULT 0,
        quota     INT DEFAULT 0,
        UNIQUE (tenant_id, channel, month)
      );
    `);

    // ── Customers ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id          SERIAL PRIMARY KEY,
        tenant_id   INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        customer_id TEXT NOT NULL,
        first_name  TEXT,
        last_name   TEXT,
        email       TEXT,
        phone       TEXT,
        expiry_date DATE,
        meta        JSONB DEFAULT '{}'::jsonb,
        created_at  TIMESTAMPTZ DEFAULT now(),
        UNIQUE (tenant_id, customer_id)
      );
    `);

    // ── Rules ──────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS rules (
        id         SERIAL PRIMARY KEY,
        tenant_id  INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        lead_days  JSONB DEFAULT '[]'::jsonb,
        channels   JSONB DEFAULT '[]'::jsonb,
        template   TEXT,
        is_active  BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT now()
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
        delivery_status TEXT,   -- delivered | opened | bounced (from webhooks)
        attempts        INT DEFAULT 0,
        retry_count     INT DEFAULT 0,
        last_error      TEXT,
        provider_msg_id TEXT,
        created_at      TIMESTAMPTZ DEFAULT now()
      );
    `);
    await client.query(`
      ALTER TABLE jobs
        ADD COLUMN IF NOT EXISTS recipient       TEXT,
        ADD COLUMN IF NOT EXISTS message         TEXT,
        ADD COLUMN IF NOT EXISTS retry_count     INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS delivery_status TEXT;
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
        status         TEXT DEFAULT 'pending',
        approved_by    INT REFERENCES tenants(id),
        approved_at    TIMESTAMPTZ,
        notes          TEXT,
        created_at     TIMESTAMPTZ DEFAULT now()
      );
    `);

    // ── Seeds ──────────────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO tenants (name, email, role)
        SELECT 'demo', 'demo@demo.com', 'user'
        WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE email = 'demo@demo.com');
    `);
    await client.query(`
      INSERT INTO tenants (name, email, role)
        SELECT 'Admin', 'admin@expirynotifier.com', 'admin'
        WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE email = 'admin@expirynotifier.com');
    `);

    await client.query('COMMIT');
    console.log('✅ DB initialized — Phase 5 migrations applied.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration error:', err);
    throw err;
  } finally {
    client.release();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function insertCustomer({ tenant_id, customer_id, first_name, last_name, email, phone, expiry_date, meta }) {
  await pool.query(
    `INSERT INTO customers (tenant_id, customer_id, first_name, last_name, email, phone, expiry_date, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, customer_id) DO UPDATE SET
       first_name  = EXCLUDED.first_name,
       last_name   = EXCLUDED.last_name,
       email       = EXCLUDED.email,
       phone       = EXCLUDED.phone,
       expiry_date = EXCLUDED.expiry_date,
       meta        = EXCLUDED.meta`,
    [tenant_id, customer_id, first_name, last_name, email, phone, expiry_date, meta || {}]
  );
}

async function createRule({ tenant_id, name, lead_days, channels, template }) {
  const { rows } = await pool.query(
    `INSERT INTO rules (tenant_id, name, lead_days, channels, template)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5) RETURNING *`,
    [tenant_id, name, JSON.stringify(lead_days), JSON.stringify(channels), template]
  );
  return rows[0];
}

async function getActiveRules() {
  const { rows } = await pool.query(`SELECT * FROM rules WHERE is_active = true`);
  return rows;
}

async function jobExists(tenant_id, customer_id, rule_id, channel, scheduled_at) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM jobs WHERE tenant_id=$1 AND customer_id=$2 AND rule_id=$3 AND channel=$4 AND scheduled_at=$5`,
    [tenant_id, customer_id, rule_id, channel, scheduled_at]
  );
  return rowCount > 0;
}

async function createJob({ tenant_id, customer_id, rule_id, channel, scheduled_at, recipient }) {
  await pool.query(
    `INSERT INTO jobs (tenant_id, customer_id, rule_id, channel, scheduled_at, recipient)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenant_id, customer_id, rule_id, channel, scheduled_at, recipient || null]
  );
}

async function getPendingJobs(limit = 50) {
  const { rows } = await pool.query(
    `WITH claimed AS (
       UPDATE jobs SET status = 'queued'
       WHERE id IN (
         SELECT id FROM jobs WHERE status = 'pending' AND scheduled_at <= NOW()
         ORDER BY scheduled_at LIMIT $1 FOR UPDATE SKIP LOCKED
       ) RETURNING id
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
  await pool.query(`UPDATE jobs SET status='sent', provider_msg_id=$2 WHERE id=$1`, [job_id, provider_msg_id]);
}

async function markJobFailed(job_id, error) {
  await pool.query(`UPDATE jobs SET status='permanent_failed', attempts=attempts+1, last_error=$2 WHERE id=$1`, [job_id, error]);
}

async function rescheduleJob(job_id, delayMinutes, error) {
  await pool.query(
    `UPDATE jobs SET
       scheduled_at = NOW() + ($2 * INTERVAL '1 minute'),
       retry_count  = COALESCE(retry_count,0) + 1,
       attempts     = attempts + 1,
       status       = 'pending',
       last_error   = $3
     WHERE id = $1`,
    [job_id, delayMinutes, error]
  );
}

function currentMonth() { return new Date().toISOString().slice(0, 7); }

async function incrementChannelUsage(tenant_id, channel, quota) {
  const month = currentMonth();
  await pool.query(
    `INSERT INTO channel_usage (tenant_id, channel, month, used, quota)
     VALUES ($1,$2,$3,1,$4)
     ON CONFLICT (tenant_id, channel, month) DO UPDATE
       SET used = channel_usage.used + 1, quota = EXCLUDED.quota`,
    [tenant_id, channel, month, quota]
  );
}

async function getChannelUsage(tenant_id) {
  const month = currentMonth();
  const { rows } = await pool.query(
    `SELECT channel, used, quota FROM channel_usage WHERE tenant_id=$1 AND month=$2`,
    [tenant_id, month]
  );
  return rows;
}

// Fire-and-forget audit writer — never throws
async function writeAudit({ tenant_id, actor_id, actor_email, action, target_type, target_id, meta, ip }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_id, actor_email, action, target_type, target_id, meta, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        tenant_id   ?? null,
        actor_id    ?? null,
        actor_email ?? null,
        action,
        target_type ?? null,
        target_id   != null ? String(target_id) : null,
        meta        ?? {},
        ip          ?? null,
      ]
    );
  } catch (e) {
    console.error('[audit] write failed:', e.message);
  }
}

module.exports = {
  pool, initDB,
  insertCustomer, createRule, getActiveRules,
  jobExists, createJob, getPendingJobs,
  markJobSent, markJobFailed, rescheduleJob,
  incrementChannelUsage, getChannelUsage, currentMonth,
  writeAudit,
};
