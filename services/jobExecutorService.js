const { getPendingJobs, markJobSent, markJobFailed, rescheduleJob } = require('../db');
const { sendNotification } = require('./notificationService');

const MAX_RETRIES = 3;

async function runJobExecutor() {
  try {
    const jobs = await getPendingJobs(50);
    console.log(`🚚 Executor found ${jobs.length} pending job(s)`);

    for (const job of jobs) {
      console.log(`➡ Processing job ${job.id} (${job.channel}) -> to: ${job.email || job.phone}`);

      try {
        const providerMsgId = await sendNotification(job);
        await markJobSent(job.id, providerMsgId);
        console.log(`✅ Job ${job.id} sent (provider id: ${providerMsgId})`);
      } catch (err) {
        const currentRetries = job.retry_count || 0;
        console.error(`❌ Job ${job.id} failed (retry ${currentRetries}):`, err.message);

        if (currentRetries < MAX_RETRIES) {
          const nextRetryCount = currentRetries + 1;
          const delayMinutes = Math.pow(2, nextRetryCount); // 2^retry_count minutes
          await rescheduleJob(job.id, delayMinutes, err.message);
          console.log(
            `🔁 Job ${job.id} rescheduled in ${delayMinutes} minute(s), retry_count=${nextRetryCount}`
          );
        } else {
          await markJobFailed(job.id, err.message);
          console.log(`🛑 Job ${job.id} marked as permanent_failed after ${currentRetries} retries`);
        }
      }
    }
  } catch (err) {
    console.error('🔥 Executor crashed:', err.message);
  }
}

module.exports = {
  runJobExecutor
};
