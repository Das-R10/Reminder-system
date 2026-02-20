const { pool } = require('../db');

// Same plan definitions as routes/tenant.js (no behavior change)
const PLANS = {
  starter: { amount: 999, jobs: 2000 },
  business: { amount: 3999, jobs: 10000 }
};

const VALID_PAYMENT_METHODS = ['upi', 'bank', 'international'];

function getPlan(planKey) {
  return PLANS[planKey];
}

async function createPurchaseRequest(tenantId, plan, payment_method) {
  const planConfig = getPlan(plan);
  if (!planConfig) {
    const err = new Error('Invalid plan');
    err.code = 'INVALID_PLAN';
    err.statusCode = 400;
    throw err;
  }

  if (!VALID_PAYMENT_METHODS.includes(payment_method)) {
    const err = new Error('Invalid payment method');
    err.code = 'INVALID_PAYMENT_METHOD';
    err.statusCode = 400;
    throw err;
  }

  await pool.query(
    `INSERT INTO purchase_requests
     (tenant_id, plan, amount, payment_method)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, plan, planConfig.amount, payment_method]
  );
}

module.exports = {
  createPurchaseRequest,
  getPlan
};
