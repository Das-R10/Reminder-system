// tenantService.js
const { pool, incrementChannelUsage, getChannelUsage, currentMonth } = require('../db');
const { getChannelPlan, getChannelQuota, getEnabledChannels } = require('../plans');
const fs = require('fs');
const csvParser = require('csv-parser');

async function getTenant(tenantId) {
  const { rows } = await pool.query('SELECT * FROM tenants WHERE id=$1', [tenantId]);
  return rows[0] || null;
}

async function getStats(tenantId) {
  const tenant = await getTenant(tenantId);
  if (!tenant) return null;

  const usageRows = await getChannelUsage(tenantId);
  const usageMap  = {};
  usageRows.forEach(r => { usageMap[r.channel] = r; });

  const activePlans = tenant.active_plans || [];
  const channels    = ['email', 'sms', 'whatsapp'];

  const channelStats = channels.map(ch => {
    const quota = getChannelQuota(activePlans, ch);
    const used  = usageMap[ch]?.used || 0;
    return {
      channel: ch,
      enabled: quota > 0,
      used,
      quota,
      remaining: Math.max(0, quota - used)
    };
  });

  // total failed jobs this month
  const month = currentMonth();
  const { rows: failRows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM jobs
     WHERE tenant_id=$1
       AND status IN ('failed','permanent_failed')
       AND created_at >= date_trunc('month', NOW())`,
    [tenantId]
  );

  return {
    tenant_id:    tenantId,
    company_name: tenant.name,
    active_plans: activePlans,
    channel_stats: channelStats,
    failed_jobs:  parseInt(failRows[0].cnt, 10)
  };
}

async function getJobLogs(tenantId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, channel, recipient, status, created_at, last_error
     FROM jobs
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit]
  );
  return rows;
}

/**
 * Create a single job with per-channel limit enforcement.
 * Used by /api/jobs (direct) and bulk CSV upload.
 */
async function createJobWithLimitCheck(tenantId, channel, recipient, message) {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    const err = new Error('Tenant not found');
    err.code = 'TENANT_NOT_FOUND';
    throw err;
  }

  const activePlans = tenant.active_plans || [];
  const quota       = getChannelQuota(activePlans, channel);

  if (quota === 0) {
    const err = new Error(`Channel '${channel}' is not enabled. Please upgrade your plan.`);
    err.code  = 'CHANNEL_NOT_ENABLED';
    throw err;
  }

  // Check current month usage
  const usageRows = await getChannelUsage(tenantId);
  const usageRow  = usageRows.find(r => r.channel === channel);
  const used      = usageRow?.used || 0;

  if (used >= quota) {
    const err = new Error(`Monthly ${channel} limit (${quota}) exceeded. Please upgrade.`);
    err.code  = 'LIMIT_EXCEEDED';
    throw err;
  }

  // Insert job with status 'sent' for direct/bulk jobs (immediate)
  const jobRes = await pool.query(
    `INSERT INTO jobs (tenant_id, channel, recipient, message, status)
     VALUES ($1, $2, $3, $4, 'sent')
     RETURNING id`,
    [tenantId, channel.toLowerCase(), recipient, message]
  );

  // Increment usage counter
  await incrementChannelUsage(tenantId, channel, quota);

  return { job_id: jobRes.rows[0].id };
}

/**
 * Bulk upload from CSV. Columns: channel, recipient, message
 */
async function bulkUploadJobsFromCsv(tenantId, filePath) {
  const summary = {
    total_rows:    0,
    success_count: 0,
    failed_count:  0,
    failed_rows:   []
  };

  return new Promise((resolve, reject) => {
    const rowPromises = [];
    let rowNumber = 0;

    const stream = fs.createReadStream(filePath).pipe(csvParser());

    stream.on('data', (row) => {
      rowNumber += 1;
      summary.total_rows += 1;
      const currentRow = rowNumber;

      const channelRaw = (row.channel  || '').toString().trim().toLowerCase();
      const recipient  = (row.recipient || '').toString().trim();
      const message    = (row.message   || '').toString().trim();

      const errors = [];
      if (!['email', 'sms', 'whatsapp'].includes(channelRaw)) {
        errors.push('channel must be email, sms, or whatsapp');
      }
      if (!recipient) errors.push('recipient must not be empty');
      if (!message)   errors.push('message must not be empty');

      if (errors.length > 0) {
        summary.failed_rows.push({ row_number: currentRow, error: errors.join('; ') });
        return;
      }

      const p = createJobWithLimitCheck(tenantId, channelRaw, recipient, message)
        .then(() => { summary.success_count += 1; })
        .catch((err) => {
          summary.failed_rows.push({
            row_number: currentRow,
            error: err?.message || 'Unknown error'
          });
        });

      rowPromises.push(p);
    });

    stream.on('end', () => {
      Promise.all(rowPromises)
        .then(() => {
          summary.failed_count = summary.failed_rows.length;
          resolve(summary);
        })
        .catch(reject);
    });

    stream.on('error', reject);
  }).finally(() => {
    fs.unlink(filePath, () => {});
  });
}

module.exports = {
  getTenant,
  getStats,
  getJobLogs,
  createJobWithLimitCheck,
  bulkUploadJobsFromCsv
};