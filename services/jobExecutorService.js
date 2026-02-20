const { getPendingJobs, markJobSent, markJobFailed } = require('../db');
const { sendNotification } = require('./notificationService');

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
        console.error(`❌ Job ${job.id} failed:`, err.message);
        await markJobFailed(job.id, err.message);
      }
    }
  } catch (err) {
    console.error('🔥 Executor crashed:', err.message);
  }
}

module.exports = {
  runJobExecutor
};
