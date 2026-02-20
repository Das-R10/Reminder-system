const { pool } = require('../db');

async function getStats(tenantId) {
  const { rows } = await pool.query(
    `SELECT plan, jobs_used, job_limit,
      (SELECT COUNT(*) FROM jobs
       WHERE tenant_id = $1 AND status = 'failed') AS failed_jobs
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  return rows;
}

async function getJobLogs(tenantId) {
  const { rows } = await pool.query(
    `SELECT channel, recipient, status, created_at
     FROM jobs
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [tenantId]
  );
  return rows;
}

async function createJobWithLimitCheck(tenantId, channel, recipient, message) {
  const tenantRes = await pool.query(
    'SELECT jobs_used, job_limit FROM tenants WHERE id=$1',
    [tenantId]
  );

  const tenant = tenantRes.rows[0];
  if (!tenant) {
    const err = new Error('Tenant not found');
    err.code = 'TENANT_NOT_FOUND';
    throw err;
  }

  if (tenant.jobs_used >= tenant.job_limit) {
    const err = new Error('Plan limit exceeded. Please upgrade.');
    err.code = 'LIMIT_EXCEEDED';
    err.statusCode = 403;
    throw err;
  }

  const jobRes = await pool.query(
    `INSERT INTO jobs (tenant_id, channel, recipient, message, status)
     VALUES ($1, $2, $3, $4, 'sent')
     RETURNING id`,
    [tenantId, channel.toLowerCase(), recipient, message]
  );

  await pool.query(
    'UPDATE tenants SET jobs_used = jobs_used + 1 WHERE id=$1',
    [tenantId]
  );

  return { job_id: jobRes.rows[0].id };
}

module.exports = {
  getStats,
  getJobLogs,
  createJobWithLimitCheck
};
