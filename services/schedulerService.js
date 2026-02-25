// schedulerService.js
const { pool, getActiveRules, jobExists, createJob } = require('../db');
const { getEnabledChannels } = require('../plans');

async function runScheduler() {
  console.log('⏱ Running expiry scheduler...');

  let rules;
  try {
    rules = await getActiveRules();
  } catch (err) {
    console.error('🔥 Scheduler failed to load rules:', err.message);
    return;
  }

  for (const rule of rules) {
    const { tenant_id, id: rule_id, lead_days, channels } = rule;

    // Load tenant to check which channels are enabled on their plan
    let tenant;
    try {
      const { rows } = await pool.query('SELECT * FROM tenants WHERE id=$1', [tenant_id]);
      tenant = rows[0];
    } catch (err) {
      console.error(`Scheduler: failed to load tenant ${tenant_id}:`, err.message);
      continue;
    }

    if (!tenant) continue;

    const enabledChannels = getEnabledChannels(tenant.active_plans || []);

    // Filter rule channels to only those the tenant has active plans for
    const allowedChannels = channels.filter(ch => enabledChannels.includes(ch));

    if (!allowedChannels.length) {
      console.log(`⚠ Tenant ${tenant_id} has no enabled channels for rule ${rule_id} — skipping`);
      continue;
    }

    let customers;
    try {
      const { rows } = await pool.query(
        `SELECT * FROM customers WHERE tenant_id=$1 AND expiry_date IS NOT NULL`,
        [tenant_id]
      );
      customers = rows;
    } catch (err) {
      console.error(`Scheduler: failed to load customers for tenant ${tenant_id}:`, err.message);
      continue;
    }

    for (const customer of customers) {
      for (const days of lead_days) {
        const scheduled = new Date(customer.expiry_date);
        scheduled.setDate(scheduled.getDate() - days);
        scheduled.setUTCHours(9, 0, 0, 0); // Send at 9 AM UTC
        const scheduled_at = scheduled.toISOString();

        for (const channel of allowedChannels) {
          const recipient =
            channel === 'email'     ? customer.email :
            channel === 'sms'       ? customer.phone :
            channel === 'whatsapp'  ? customer.phone : null;

          if (!recipient) {
            console.log(`⚠ Skipping ${channel} for customer=${customer.customer_id} (missing contact)`);
            continue;
          }

          try {
            const exists = await jobExists(tenant_id, customer.id, rule_id, channel, scheduled_at);
            if (!exists) {
              await createJob({
                tenant_id,
                customer_id:  customer.id,
                rule_id,
                channel,
                scheduled_at,
                recipient
              });
              console.log(`📌 Job created → customer=${customer.customer_id}, channel=${channel}, date=${scheduled_at}`);
            }
          } catch (err) {
            console.error(`Scheduler: failed to create job for customer=${customer.customer_id}:`, err.message);
          }
        }
      }
    }
  }

  console.log('⏱ Scheduler run complete.');
}

module.exports = { runScheduler };