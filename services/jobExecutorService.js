// jobExecutorService.js
const { pool, markJobSent, markJobFailed, rescheduleJob, incrementChannelUsage } = require('../db');
const { getChannelQuota, getEnabledChannels }  = require('../plans');
const { sendNotification } = require('./notificationService');

const MAX_RETRIES = 3;

async function runJobExecutor() {
  const client = await pool.connect();
  let jobs = [];

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE jobs SET status = 'queued'
       WHERE id IN (
         SELECT id FROM jobs
         WHERE status = 'pending' AND scheduled_at <= NOW()
         ORDER BY scheduled_at
         LIMIT 50
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`
    );

    const claimedIds = result.rows.map(r => r.id);
    if (!claimedIds.length) {
      await client.query('COMMIT');
      client.release();
      return;
    }

    const jobsResult = await client.query(
      `SELECT j.*, c.email, c.phone, c.first_name, c.last_name, c.expiry_date,
              r.template, t.active_plans, t.name AS company_name
       FROM jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       LEFT JOIN rules r     ON r.id = j.rule_id
       LEFT JOIN tenants t   ON t.id = j.tenant_id
       WHERE j.id = ANY($1::int[])`,
      [claimedIds]
    );

    jobs = jobsResult.rows;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('🔥 Executor failed to claim jobs:', err.message);
    client.release();
    return;
  }

  client.release();
  console.log(`🚚 Executor claimed ${jobs.length} job(s)`);

  for (const job of jobs) {
    // Check if tenant still has this channel enabled
    const activePlans     = job.active_plans || [];
    const enabledChannels = getEnabledChannels(activePlans);
    const quota           = getChannelQuota(activePlans, job.channel);

    if (!enabledChannels.includes(job.channel)) {
      console.log(`⚠ Job ${job.id} skipped — tenant channel '${job.channel}' not in active plans`);
      await markJobFailed(job.id, `Channel '${job.channel}' not enabled on tenant plan`);
      continue;
    }

    console.log(`➡ Processing job ${job.id} (${job.channel}) → ${job.email || job.phone || job.recipient}`);

    try {
      // Merge recipient from jobs table if customer join returned null
      const enrichedJob = {
        ...job,
        email: job.email || (job.channel === 'email' ? job.recipient : null),
        phone: job.phone || (['sms','whatsapp'].includes(job.channel) ? job.recipient : null)
      };

      const providerMsgId = await sendNotification(enrichedJob);
      await markJobSent(job.id, providerMsgId);

      // Track channel usage
      await incrementChannelUsage(job.tenant_id, job.channel, quota);

      console.log(`✅ Job ${job.id} sent via ${job.channel} (provider id: ${providerMsgId})`);
    } catch (err) {
      const retries = job.retry_count || 0;
      console.error(`❌ Job ${job.id} failed (retry ${retries}):`, err.message);

      if (retries < MAX_RETRIES) {
        const nextRetry    = retries + 1;
        const delayMinutes = Math.pow(2, nextRetry); // 2, 4, 8 mins
        await rescheduleJob(job.id, delayMinutes, err.message);
        console.log(`🔁 Job ${job.id} rescheduled in ${delayMinutes}m (retry ${nextRetry})`);
      } else {
        await markJobFailed(job.id, err.message);
        console.log(`🛑 Job ${job.id} permanently failed after ${retries} retries`);
      }
    }
  }
}

module.exports = { runJobExecutor };