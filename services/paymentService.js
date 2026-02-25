// paymentService.js
const { pool } = require('../db');
const { getChannelPlan } = require('../plans');

const VALID_PAYMENT_METHODS = ['upi', 'bank', 'international'];

/**
 * Create a purchase request (pending admin approval).
 * plan_id can be a channel plan or combo plan.
 */
async function createPurchaseRequest(tenantId, planId, paymentMethod) {
  const plan = getChannelPlan(planId);
  if (!plan) {
    const err = new Error(`Invalid plan: ${planId}`);
    err.code = 'INVALID_PLAN';
    throw err;
  }

  if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    const err = new Error(`Invalid payment method: ${paymentMethod}`);
    err.code = 'INVALID_PAYMENT_METHOD';
    throw err;
  }

  const { rows } = await pool.query(
    `INSERT INTO purchase_requests (tenant_id, plan_id, amount, payment_method)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [tenantId, planId, plan.price, paymentMethod]
  );

  return { request_id: rows[0].id, amount: plan.price };
}

/**
 * Admin: approve a purchase request and activate the plan on the tenant.
 */
async function approvePurchaseRequest(requestId, adminId) {
  const { rows } = await pool.query(
    `SELECT * FROM purchase_requests WHERE id=$1`, [requestId]
  );
  if (!rows.length) {
    const err = new Error('Purchase request not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const req = rows[0];
  if (req.status !== 'pending') {
    const err = new Error(`Request is already ${req.status}`);
    err.code = 'ALREADY_PROCESSED';
    throw err;
  }

  const plan = getChannelPlan(req.plan_id);
  if (!plan) {
    const err = new Error('Plan no longer exists');
    err.code = 'INVALID_PLAN';
    throw err;
  }

  // Activate plan on tenant (merge into active_plans array, avoid duplicates)
  await pool.query(
    `UPDATE tenants
     SET active_plans = (
       SELECT jsonb_agg(DISTINCT val)
       FROM (
         SELECT jsonb_array_elements_text(COALESCE(active_plans, '[]'::jsonb)) AS val
         UNION ALL
         SELECT $2::text
       ) sub
     )
     WHERE id = $1`,
    [req.tenant_id, req.plan_id]
  );

  // Mark request as approved
  await pool.query(
    `UPDATE purchase_requests
     SET status='approved', approved_by=$2, approved_at=NOW()
     WHERE id=$1`,
    [requestId, adminId]
  );

  return { tenant_id: req.tenant_id, plan_id: req.plan_id };
}

/**
 * Admin: reject a purchase request.
 */
async function rejectPurchaseRequest(requestId, adminId, notes = '') {
  await pool.query(
    `UPDATE purchase_requests
     SET status='rejected', approved_by=$2, approved_at=NOW(), notes=$3
     WHERE id=$1`,
    [requestId, adminId, notes]
  );
}

/**
 * Get all purchase requests (admin view).
 */
async function getAllPurchaseRequests(status = null) {
  let query = `
    SELECT pr.*, t.name AS company_name, t.email AS company_email
    FROM purchase_requests pr
    JOIN tenants t ON t.id = pr.tenant_id
  `;
  const params = [];
  if (status) {
    query += ` WHERE pr.status = $1`;
    params.push(status);
  }
  query += ` ORDER BY pr.created_at DESC`;
  const { rows } = await pool.query(query, params);
  return rows;
}

module.exports = {
  createPurchaseRequest,
  approvePurchaseRequest,
  rejectPurchaseRequest,
  getAllPurchaseRequests
};