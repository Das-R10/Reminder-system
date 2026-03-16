// services/jobExecutorService.js
// Tracks in-flight jobs so graceful shutdown can drain before exit.

const { pool, markJobSent, markJobFailed, rescheduleJob, incrementChannelUsage } = require('../db');
const { getChannelQuota, getEnabledChannels } = require('../plans');
const { sendNotification } = require('./notificationService');
const { executor: log }    = require('./logger');

const MAX_RETRIES = 3;

// ── In-flight tracking ────────────────────────────────────────────────────────
// Holds Promises of all currently processing jobs. Used by drain() below.
const _inFlight = new Set();

function _track(promise) {
  _inFlight.add(promise);
  promise.finally(() => _inFlight.delete(promise));
}

// Wait for all in-flight jobs to finish. Called during graceful shutdown.
async function drain() {
  if (_inFlight.size === 0) return;
  log.info({ count: _inFlight.size }, 'Draining in-flight jobs before shutdown...');
  await Promise.allSettled([..._inFlight]);
  log.info('All in-flight jobs drained');
}

// ── Main executor ─────────────────────────────────────────────────────────────
async function runJobExecutor() {
  const client = await pool.connect();
  let jobs = [];

  try {
    await client.query('BEGIN');

    // Atomically claim up to 50 pending jobs — FOR UPDATE SKIP LOCKED ensures
    // multiple instances never pick the same job.
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

    const ids = result.rows.map(r => r.id);
    if (!ids.length) { await client.query('COMMIT'); client.release(); return; }

    const { rows } = await client.query(
      `SELECT j.*, c.email, c.phone, c.first_name, c.last_name, c.expiry_date,
              r.template, t.active_plans, t.name AS company_name
       FROM jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       LEFT JOIN rules r     ON r.id = j.rule_id
       LEFT JOIN tenants t   ON t.id = j.tenant_id
       WHERE j.id = ANY($1::int[])`,
      [ids]
    );
    jobs = rows;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    log.error({ err }, 'Failed to claim jobs');
    client.release();
    return;
  }

  client.release();
  log.info({ count: jobs.length }, 'Jobs claimed');

  for (const job of jobs) {
    const promise = _processJob(job);
    _track(promise);
  }
}

async function _processJob(job) {
  const activePlans     = job.active_plans || [];
  const enabledChannels = getEnabledChannels(activePlans);
  const quota           = getChannelQuota(activePlans, job.channel);

  if (!enabledChannels.includes(job.channel)) {
    log.warn({ job_id: job.id, channel: job.channel }, 'Channel not enabled on plan — failing job');
    await markJobFailed(job.id, `Channel '${job.channel}' not enabled on tenant plan`);
    return;
  }

  const enriched = {
    ...job,
    email: job.email || (job.channel === 'email' ? job.recipient : null),
    phone: job.phone || (['sms','whatsapp'].includes(job.channel) ? job.recipient : null)
  };

  log.info({ job_id: job.id, channel: job.channel, recipient: enriched.email || enriched.phone }, 'Processing job');

  try {
    const providerMsgId = await sendNotification(enriched);
    await markJobSent(job.id, providerMsgId);
    await incrementChannelUsage(job.tenant_id, job.channel, quota);
    log.info({ job_id: job.id, provider_msg_id: providerMsgId }, 'Job sent');
  } catch (err) {
    const retries = job.retry_count || 0;
    log.error({ err, job_id: job.id, retry: retries }, 'Job failed');

    if (retries < MAX_RETRIES) {
      const delay = Math.pow(2, retries + 1); // 2, 4, 8 min
      await rescheduleJob(job.id, delay, err.message);
      log.info({ job_id: job.id, delay_minutes: delay, next_retry: retries + 1 }, 'Job rescheduled');
    } else {
      await markJobFailed(job.id, err.message);
      log.warn({ job_id: job.id }, 'Job permanently failed after max retries');
    }
  }
}

module.exports = { runJobExecutor, drain };
