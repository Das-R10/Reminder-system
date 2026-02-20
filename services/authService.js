const { pool } = require('../db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

function issueToken(tenant) {
  return jwt.sign(
    {
      id: tenant.id,
      role: tenant.role || 'user',
      email: tenant.email,
      company_name: tenant.name
    },
    JWT_SECRET,
    { expiresIn: '1d' }
  );
}

async function findOrCreateTenant(email, name) {
  const existing = await pool.query(
    'SELECT * FROM tenants WHERE email = $1',
    [email]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const result = await pool.query(
    `INSERT INTO tenants (name, email, role)
     VALUES ($1, $2, 'user')
     RETURNING *`,
    [name || email.split('@')[0], email]
  );

  return result.rows[0];
}

async function signup(company_name, email, password) {
  const hashed = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO tenants (name, email, password, role)
     VALUES ($1, $2, $3, 'user')`,
    [company_name, email, hashed]
  );
}

async function login(email, password) {
  const result = await pool.query(
    'SELECT * FROM tenants WHERE email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    const err = new Error('User not found');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  const user = result.rows[0];
  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    const err = new Error('Invalid password');
    err.code = 'INVALID_PASSWORD';
    throw err;
  }

  const token = issueToken(user);
  return {
    token,
    role: user.role,
    company_name: user.name
  };
}

module.exports = {
  findOrCreateTenant,
  signup,
  login,
  issueToken
};
