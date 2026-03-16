// services/logger.js — no external deps, drop-in pino-compatible API
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const MIN    = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function log(level, msg, extra) {
  if (LEVELS[level] < MIN) return;
  const prefix = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)}`;
  const out    = level === 'error' || level === 'fatal' ? console.error : console.log;
  extra && Object.keys(extra).length ? out(prefix, msg, extra) : out(prefix, msg);
}

const make = (bindings = {}) => ({
  trace: (msg, x={}) => log('trace', msg, {...bindings,...x}),
  debug: (msg, x={}) => log('debug', msg, {...bindings,...x}),
  info:  (msg, x={}) => log('info',  msg, {...bindings,...x}),
  warn:  (msg, x={}) => log('warn',  msg, {...bindings,...x}),
  error: (msg, x={}) => log('error', msg, {...bindings,...x}),
  fatal: (msg, x={}) => log('fatal', msg, {...bindings,...x}),
  child: (b={}) => make({...bindings,...b}),
});

module.exports = make();