// services/tokenService.js
// Handles: email verification tokens, password reset tokens, refresh tokens

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const { pool } = require('../db');

const JWT_SECRET         = process.env.JWT_SECRET;
const REFRESH_SECRET     = process.env.REFRESH_SECRET || JWT_SECRET + '_refresh';
const TOKEN_BYTES        = 32; // 256-bit random tokens

// ── Helpers ────────────────────────────────────────────────────────────────────
function randomToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// ── Email Verification ─────────────────────────────────────────────────────────
async function createVerificationToken(tenantId) {
  const token     = randomToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await pool.query(
    `INSERT INTO email_verifications (tenant_id, token, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE
       SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at, used = false`,
    [tenantId, token, expiresAt]
  );
  return token;
}

async function verifyEmailToken(token) {
  const { rows } = await pool.query(
    `SELECT * FROM email_verifications
     WHERE token = $1 AND used = false AND expires_at > NOW()`,
    [token]
  );
  if (!rows.length) {
    const err = new Error('Invalid or expired verification token');
    err.code = 'INVALID_TOKEN';
    throw err;
  }

  const rec = rows[0];

  // Mark used + mark tenant verified in one transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE email_verifications SET used = true WHERE id = $1`, [rec.id]
    );
    await client.query(
      `UPDATE tenants SET email_verified = true WHERE id = $1`, [rec.tenant_id]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return rec.tenant_id;
}

// ── Password Reset ─────────────────────────────────────────────────────────────
async function createPasswordResetToken(tenantId) {
  const token     = randomToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h

  await pool.query(
    `INSERT INTO password_resets (tenant_id, token, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE
       SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at, used = false`,
    [tenantId, token, expiresAt]
  );
  return token;
}

async function verifyPasswordResetToken(token) {
  const { rows } = await pool.query(
    `SELECT * FROM password_resets
     WHERE token = $1 AND used = false AND expires_at > NOW()`,
    [token]
  );
  if (!rows.length) {
    const err = new Error('Invalid or expired reset token');
    err.code = 'INVALID_TOKEN';
    throw err;
  }
  return rows[0];
}

async function consumePasswordResetToken(tokenId) {
  await pool.query(
    `UPDATE password_resets SET used = true WHERE id = $1`, [tokenId]
  );
}

// ── Refresh Tokens ─────────────────────────────────────────────────────────────
async function createRefreshToken(tenantId) {
  const token     = randomToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await pool.query(
    `INSERT INTO refresh_tokens (tenant_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [tenantId, token, expiresAt]
  );
  return token;
}

async function verifyRefreshToken(token) {
  const { rows } = await pool.query(
    `SELECT rt.*, t.role, t.email, t.name, t.email_verified
     FROM refresh_tokens rt
     JOIN tenants t ON t.id = rt.tenant_id
     WHERE rt.token = $1 AND rt.revoked = false AND rt.expires_at > NOW()`,
    [token]
  );
  if (!rows.length) {
    const err = new Error('Invalid or expired refresh token');
    err.code = 'INVALID_TOKEN';
    throw err;
  }
  return rows[0];
}

async function revokeRefreshToken(token) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked = true WHERE token = $1`, [token]
  );
}

// Revoke ALL refresh tokens for a tenant (on password change / suspicious activity)
async function revokeAllRefreshTokens(tenantId) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked = true WHERE tenant_id = $1`, [tenantId]
  );
}

// ── Access token issue (short-lived JWT) ──────────────────────────────────────
function issueAccessToken(tenant) {
  return jwt.sign(
    {
      id:           tenant.id,
      role:         tenant.role || 'user',
      email:        tenant.email,
      company_name: tenant.name || tenant.company_name
    },
    JWT_SECRET,
    { expiresIn: '15m' }  // short-lived — refresh token handles renewal
  );
}

module.exports = {
  createVerificationToken,
  verifyEmailToken,
  createPasswordResetToken,
  verifyPasswordResetToken,
  consumePasswordResetToken,
  createRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  issueAccessToken
};