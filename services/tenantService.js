const { pool } = require('../db');
const fs = require('fs');
const csvParser = require('csv-parser');

async function getStats(tenantId) {
  const { rows } = await pool.query(
    `SELECT plan, jobs_used, job_limit,
      (SELECT COUNT(*) FROM jobs
       WHERE tenant_id = $1 AND status IN ('failed','permanent_failed')) AS failed_jobs
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

/**
 * Stream and process a CSV file of jobs for a tenant.
 * CSV columns: channel, recipient, message
 */
async function bulkUploadJobsFromCsv(tenantId, filePath) {
  const summary = {
    total_rows: 0,
    success_count: 0,
    failed_count: 0,
    failed_rows: []
  };

  const stream = fs.createReadStream(filePath).pipe(csvParser());

  let rowNumber = 0;

  return new Promise((resolve, reject) => {
    stream.on('data', (row) => {
      stream.pause();
      rowNumber += 1;
      summary.total_rows += 1;

      const channelRaw = (row.channel || '').toString().trim().toLowerCase();
      const recipient = (row.recipient || '').toString().trim();
      const message = (row.message || '').toString().trim();

      const errors = [];
      if (!channelRaw || (channelRaw !== 'email' && channelRaw !== 'sms')) {
        errors.push('channel must be email or sms');
      }
      if (!recipient) {
        errors.push('recipient must not be empty');
      }
      if (!message) {
        errors.push('message must not be empty');
      }

      if (errors.length > 0) {
        summary.failed_rows.push({
          row_number: rowNumber,
          error: errors.join('; ')
        });
        stream.resume();
        return;
      }

      createJobWithLimitCheck(tenantId, channelRaw, recipient, message)
        .then(() => {
          summary.success_count += 1;
          stream.resume();
        })
        .catch((err) => {
          const msg = err && err.message ? err.message : 'Unknown error';
          summary.failed_rows.push({
            row_number: rowNumber,
            error: msg
          });
          stream.resume();
        });
    });

    stream.on('end', () => {
      summary.failed_count = summary.failed_rows.length;
      resolve(summary);
    });

    stream.on('error', (err) => {
      reject(err);
    });
  }).finally(() => {
    fs.unlink(filePath, () => {});
  });
}

module.exports = {
  getStats,
  getJobLogs,
  createJobWithLimitCheck,
  bulkUploadJobsFromCsv
};
