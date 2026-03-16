// services/tenantService.js — Phase 5
const { pool, incrementChannelUsage, getChannelUsage, currentMonth } = require('../db');
const { getChannelQuota, getEnabledChannels } = require('../plans');
const fs        = require('fs');
const csvParser = require('csv-parser');

async function getTenant(tenantId) {
  const { rows } = await pool.query('SELECT * FROM tenants WHERE id=$1', [tenantId]);
  return rows[0] || null;
}

async function getStats(tenantId) {
  const tenant = await getTenant(tenantId);
  if (!tenant) return null;

  const [usageRows, failRow, customerRow, dlqRow] = await Promise.all([
    getChannelUsage(tenantId),
    pool.query(
      `SELECT COUNT(*) AS cnt FROM jobs
       WHERE tenant_id=$1 AND status IN ('failed','permanent_failed')
         AND created_at >= date_trunc('month', NOW())`,
      [tenantId]
    ),
    pool.query(`SELECT COUNT(*) AS cnt FROM customers WHERE tenant_id=$1`, [tenantId]),
    pool.query(`SELECT COUNT(*) AS cnt FROM jobs WHERE tenant_id=$1 AND status='permanent_failed'`, [tenantId]),
  ]);

  const usageMap = {};
  usageRows.forEach(r => { usageMap[r.channel] = r; });

  const activePlans  = tenant.active_plans || [];
  const channelStats = ['email', 'sms', 'whatsapp'].map(ch => {
    const quota = getChannelQuota(activePlans, ch);
    const used  = usageMap[ch]?.used || 0;
    const pct   = quota > 0 ? Math.round((used / quota) * 100) : 0;
    return { channel: ch, enabled: quota > 0, used, quota, remaining: Math.max(0, quota - used), pct };
  });

  return {
    tenant_id:      tenantId,
    company_name:   tenant.name,
    active_plans:   activePlans,
    channel_stats:  channelStats,
    failed_jobs:    parseInt(failRow.rows[0].cnt, 10),
    customer_count: parseInt(customerRow.rows[0].cnt, 10),
    dlq_count:      parseInt(dlqRow.rows[0].cnt, 10),
  };
}

async function getJobLogs(tenantId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT id, channel, recipient, status, delivery_status, scheduled_at, created_at, last_error
     FROM jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit]
  );
  return rows;
}

async function createJobWithLimitCheck(tenantId, channel, recipient, message) {
  const tenant = await getTenant(tenantId);
  if (!tenant) { const e = new Error('Tenant not found'); e.code = 'TENANT_NOT_FOUND'; throw e; }

  const activePlans = tenant.active_plans || [];
  const quota       = getChannelQuota(activePlans, channel);
  if (quota === 0) { const e = new Error(`Channel '${channel}' is not enabled.`); e.code = 'CHANNEL_NOT_ENABLED'; throw e; }

  const usageRows = await getChannelUsage(tenantId);
  const used      = usageRows.find(r => r.channel === channel)?.used || 0;
  if (used >= quota) { const e = new Error(`Monthly ${channel} limit (${quota}) exceeded.`); e.code = 'LIMIT_EXCEEDED'; throw e; }

  const { rows } = await pool.query(
    `INSERT INTO jobs (tenant_id, channel, recipient, message, status)
     VALUES ($1,$2,$3,$4,'sent') RETURNING id`,
    [tenantId, channel.toLowerCase(), recipient, message]
  );
  await incrementChannelUsage(tenantId, channel, quota);
  return { job_id: rows[0].id };
}

async function bulkUploadJobsFromCsv(tenantId, filePath) {
  const summary = { total_rows: 0, success_count: 0, failed_count: 0, failed_rows: [] };
  return new Promise((resolve, reject) => {
    const rowPromises = [];
    let rowNumber = 0;
    fs.createReadStream(filePath).pipe(csvParser())
      .on('data', row => {
        rowNumber++;
        summary.total_rows++;
        const cur     = rowNumber;
        const channel = (row.channel   || '').toString().trim().toLowerCase();
        const recip   = (row.recipient || '').toString().trim();
        const msg     = (row.message   || '').toString().trim();
        const errors  = [];
        if (!['email','sms','whatsapp'].includes(channel)) errors.push('channel must be email, sms, or whatsapp');
        if (!recip) errors.push('recipient required');
        if (!msg)   errors.push('message required');
        if (errors.length) { summary.failed_rows.push({ row_number: cur, error: errors.join('; ') }); return; }
        rowPromises.push(
          createJobWithLimitCheck(tenantId, channel, recip, msg)
            .then(() => { summary.success_count++; })
            .catch(err => { summary.failed_rows.push({ row_number: cur, error: err?.message || 'Unknown' }); })
        );
      })
      .on('end', () => {
        Promise.all(rowPromises)
          .then(() => { summary.failed_count = summary.failed_rows.length; resolve(summary); })
          .catch(reject);
      })
      .on('error', reject);
  }).finally(() => { fs.unlink(filePath, () => {}); });
}

module.exports = { getTenant, getStats, getJobLogs, createJobWithLimitCheck, bulkUploadJobsFromCsv };
