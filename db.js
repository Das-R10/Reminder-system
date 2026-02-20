// db.js
require('dotenv').config();
const { Pool } = require('pg');


const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('ERROR: DATABASE_URL not set in environment');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function initDB() {


  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Tenants
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Customers
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        customer_id TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        email TEXT,
        phone TEXT,
        expiry_date DATE,
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (tenant_id, customer_id)
      );
    `);

    // Rules
    await client.query(`
      CREATE TABLE IF NOT EXISTS rules (
        id SERIAL PRIMARY KEY,
        tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        lead_days JSONB DEFAULT '[]'::jsonb,    -- e.g. [30,7,1]
        channels JSONB DEFAULT '[]'::jsonb,     -- e.g. ["email","sms"]
        template TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Jobs
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        rule_id INT REFERENCES rules(id) ON DELETE CASCADE,
        channel TEXT,
        scheduled_at TIMESTAMPTZ,
        status TEXT DEFAULT 'pending', -- pending, queued, sent, delivered, failed
        attempts INT DEFAULT 0,
        last_error TEXT,
        provider_msg_id TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS jobs_unique_idx
        ON jobs (tenant_id, customer_id, rule_id, channel, scheduled_at);
    `);


    // Optional: deliveries table (kept out for now — can add later)

    // Tenant columns required by signup/login and tenant routes (add if not present)
    await client.query(`
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS email TEXT,
        ADD COLUMN IF NOT EXISTS password TEXT,
        ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user',
        ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free',
        ADD COLUMN IF NOT EXISTS jobs_used INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS job_limit INT DEFAULT 100;
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS tenants_email_unique
      ON tenants (email) WHERE email IS NOT NULL;
    `);

    // purchase_requests: used by /api/tenant/purchase (safe defaults)
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_requests (
        id SERIAL PRIMARY KEY,
        tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        plan TEXT NOT NULL,
        amount INT NOT NULL,
        payment_method TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Insert a demo tenant if none exists (helps quick local testing)
    await client.query(`
      INSERT INTO tenants (name)
      SELECT 'demo' WHERE NOT EXISTS (SELECT 1 FROM tenants);
    `);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS businesses (
        id SERIAL PRIMARY KEY,
        company_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
    );
    `);

    await client.query(`
      ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS recipient TEXT,
      ADD COLUMN IF NOT EXISTS message TEXT;
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

async function insertCustomer(customer) {
  const {
    tenant_id,
    customer_id,
    first_name,
    last_name,
    email,
    phone,
    expiry_date,
    meta
  } = customer;

  const query = `
    INSERT INTO customers
    (tenant_id, customer_id, first_name, last_name, email, phone, expiry_date, meta)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (tenant_id, customer_id) DO NOTHING
  `;

  await pool.query(query, [
    tenant_id,
    customer_id,
    first_name,
    last_name,
    email,
    phone,
    expiry_date,
    meta || {}
  ]);
}

async function createRule(rule) {
  const { tenant_id, name, lead_days, channels, template } = rule;

  const { rows } = await pool.query(
    `
    INSERT INTO rules (tenant_id, name, lead_days, channels, template)
    VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)
    RETURNING *
    `,
    [
      tenant_id,
      name,
      JSON.stringify(lead_days),
      JSON.stringify(channels),
      template
    ]
  );

  return rows[0];
}


async function getActiveRules() {
  const { rows } = await pool.query(
    `SELECT * FROM rules WHERE is_active = true`
  );
  return rows;
}

async function jobExists(tenant_id, customer_id, rule_id, channel, scheduled_at) {
  const { rowCount } = await pool.query(
    `
    SELECT 1 FROM jobs
    WHERE tenant_id=$1 AND customer_id=$2 AND rule_id=$3
      AND channel=$4 AND scheduled_at=$5
    `,
    [tenant_id, customer_id, rule_id, channel, scheduled_at]
  );
  return rowCount > 0;
}

async function createJob(job) {
  const {
    tenant_id,
    customer_id,
    rule_id,
    channel,
    scheduled_at
  } = job;

  await pool.query(
    `
    INSERT INTO jobs (tenant_id, customer_id, rule_id, channel, scheduled_at)
    VALUES ($1, $2, $3, $4, $5)
    `,
    [tenant_id, customer_id, rule_id, channel, scheduled_at]
  );
}


// replace the whole getPendingJobs(...) function in db.js with this:
async function getPendingJobs(limit = 20) {
  const { rows } = await pool.query(
    `
    SELECT j.*, c.email, c.phone, c.first_name, c.expiry_date, r.template
    FROM jobs j
    JOIN customers c ON c.id = j.customer_id
    LEFT JOIN rules r ON r.id = j.rule_id
    WHERE j.status = 'pending'
      AND j.scheduled_at <= NOW()
    ORDER BY j.scheduled_at
    LIMIT $1
    `,
    [limit]
  );
  return rows;
}



async function markJobSent(job_id, provider_msg_id) {
  await pool.query(
    `
    UPDATE jobs
    SET status='sent', provider_msg_id=$2
    WHERE id=$1
    `,
    [job_id, provider_msg_id]
  );
}

async function markJobFailed(job_id, error) {
  await pool.query(
    `
    UPDATE jobs
    SET status='failed', attempts=attempts+1, last_error=$2
    WHERE id=$1
    `,
    [job_id, error]
  );
}

/** Find tenant by email; if none, create one with name/email and default plan. Used by /api/google-login. */
async function findOrCreateTenant(email, name) {
  const selectRes = await pool.query(
    'SELECT * FROM tenants WHERE email = $1',
    [email]
  );
  if (selectRes.rows.length > 0) {
    return selectRes.rows[0];
  }
  const { rows } = await pool.query(
    `INSERT INTO tenants (name, email, role, plan, jobs_used, job_limit)
     VALUES ($1, $2, 'user', 'free', 0, 100)
     RETURNING *`,
    [name || email, email]
  );
  return rows[0];
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
  findOrCreateTenant
};


