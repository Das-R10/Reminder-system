// services/authService.js — Phase 5
// signup now returns the full tenant row so the caller can record legal consent
const { pool } = require('../db');
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

function issueToken(tenant, extra = {}) {
  return jwt.sign(
    { id: tenant.id, role: tenant.role || 'user', email: tenant.email, company_name: tenant.name, ...extra },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function findOrCreateTenant(email, name) {
  const { rows } = await pool.query('SELECT * FROM tenants WHERE email=$1', [email]);
  if (rows.length) return rows[0];
  const res = await pool.query(
    `INSERT INTO tenants (name, email, role) VALUES ($1,$2,'user') RETURNING *`,
    [name || email.split('@')[0], email]
  );
  return res.rows[0];
}

// Returns full row (needed to record legal consent immediately after)
async function signup(company_name, email, password) {
  const hashed = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO tenants (name, email, password, role) VALUES ($1,$2,$3,'user') RETURNING *`,
    [company_name, email, hashed]
  );
  return rows[0];
}

async function login(email, password) {
  const { rows } = await pool.query('SELECT * FROM tenants WHERE email=$1', [email]);
  if (!rows.length) { const e = new Error('User not found'); e.code = 'USER_NOT_FOUND'; throw e; }
  const user = rows[0];
  if (!await bcrypt.compare(password, user.password || '')) {
    const e = new Error('Invalid password'); e.code = 'INVALID_PASSWORD'; throw e;
  }
  return { token: issueToken(user), role: user.role, company_name: user.name };
}

module.exports = { findOrCreateTenant, signup, login, issueToken };
