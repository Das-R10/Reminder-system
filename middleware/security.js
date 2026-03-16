// middleware/security.js
// Single file for: helmet, cors, rate limiting, and joi validation schemas

const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const Joi       = require('joi');

// ── Helmet — security headers ─────────────────────────────────────────────────
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc:   ['https://accounts.google.com'],
    }
  },
  crossOriginEmbedderPolicy: false
});

// ── CORS ───────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',').map(o => o.trim());

const corsMiddleware = cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials:    true
});

// ── Rate limiters ──────────────────────────────────────────────────────────────
function limitHandler(req, res) {
  res.status(429).json({ error: 'Too many requests. Please try again later.' });
}

// 10 attempts per 15 min — auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  handler: limitHandler
});

// 200 req per 15 min — general API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 200,
  standardHeaders: true, legacyHeaders: false,
  handler: limitHandler
});

// ── Joi schemas ────────────────────────────────────────────────────────────────
const passwordRule = Joi.string().min(8).max(128)
  .pattern(/[A-Z]/, 'uppercase')
  .pattern(/[0-9]/, 'number')
  .required()
  .messages({ 'string.pattern.name': 'Password needs at least one uppercase letter and one number' });

const schemas = {
  signup: Joi.object({
    company_name: Joi.string().min(2).max(100).required(),
    email:        Joi.string().email().required(),
    password:     passwordRule
  }),

  login: Joi.object({
    email:    Joi.string().email().required(),
    password: Joi.string().required()
  }),

  forgotPassword: Joi.object({
    email: Joi.string().email().required()
  }),

  resetPassword: Joi.object({
    token:    Joi.string().required(),
    password: passwordRule
  }),

  verifyEmail: Joi.object({
    token: Joi.string().required()
  }),

  refreshToken: Joi.object({
    refresh_token: Joi.string().required()
  }),

  createJob: Joi.object({
    channel:   Joi.string().valid('email', 'sms', 'whatsapp').required(),
    recipient: Joi.string().min(3).max(255).required(),
    message:   Joi.string().min(1).max(1600).required()
  }),

  purchase: Joi.object({
    plan_id:        Joi.string().required(),
    payment_method: Joi.string().valid('upi', 'bank', 'international').required()
  }),

  createRule: Joi.object({
    name:      Joi.string().max(100).optional(),
    lead_days: Joi.array().items(Joi.number().integer().min(1)).min(1).required(),
    channels:  Joi.array().items(Joi.string().valid('email','sms','whatsapp')).min(1).required(),
    template:  Joi.string().min(1).max(2000).required()
  })
};

// validate(schemaName) → Express middleware
function validate(schemaName) {
  return (req, res, next) => {
    const schema = schemas[schemaName];
    if (!schema) return next();
    const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(d => d.message)
      });
    }
    req.body = value; // sanitized + unknown fields stripped
    next();
  };
}

module.exports = { helmetMiddleware, corsMiddleware, authLimiter, apiLimiter, validate };