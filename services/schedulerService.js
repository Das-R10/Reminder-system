const { pool, getActiveRules, jobExists, createJob } = require('../db');

async function runScheduler() {
  console.log('⏱ Running expiry scheduler...');

  const rules = await getActiveRules();

  for (const rule of rules) {
    const { tenant_id, id: rule_id, lead_days, channels } = rule;

    const { rows: customers } = await pool.query(
      `SELECT * FROM customers WHERE tenant_id=$1 AND expiry_date IS NOT NULL`,
      [tenant_id]
    );

    for (const customer of customers) {
      for (const days of lead_days) {
        const scheduled = new Date(customer.expiry_date);
        scheduled.setDate(scheduled.getDate() - days);
        scheduled.setUTCHours(0, 0, 0, 0);
        const scheduled_at = scheduled.toISOString();

        for (const channel of channels) {
          const hasContact = (channel === 'email' && customer.email) || (channel === 'sms' && customer.phone);
          if (!hasContact) {
            console.log(`⚠ Skipping ${channel} for customer=${customer.customer_id} (missing contact)`);
            continue;
          }

          const exists = await jobExists(tenant_id, customer.id, rule_id, channel, scheduled_at);

          if (!exists) {
            await createJob({
              tenant_id,
              customer_id: customer.id,
              rule_id,
              channel,
              scheduled_at
            });

            console.log(`📌 Job created → customer=${customer.customer_id}, channel=${channel}, date=${scheduled_at}`);
          }
        }
      }
    }
  }
}

module.exports = {
  runScheduler
};
