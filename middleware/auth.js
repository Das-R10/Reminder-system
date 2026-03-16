// middleware/auth.js — single unified auth module; replaces authTenant.js
require('dotenv').config();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('❌ JWT_SECRET missing'); process.exit(1); }

function extractToken(req) {
  const h = req.headers.authorization;
  if (!h) return null;
  return h.startsWith('Bearer ') ? h.slice(7) : h;
}

// Any valid JWT
function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Must be role=user
function requireTenant(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Tenant access only' });
    next();
  });
}

// Must be role=admin
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// Must be tenant AND team_role=owner (or no team_role set — backwards compat with single-user tenants)
function requireOwner(req, res, next) {
  requireTenant(req, res, () => {
    if (req.user.team_role && req.user.team_role !== 'owner')
      return res.status(403).json({ error: 'Owner permission required' });
    next();
  });
}

module.exports = { requireAuth, requireTenant, requireAdmin, requireOwner };
