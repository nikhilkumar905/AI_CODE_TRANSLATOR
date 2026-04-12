const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');

// Load environment variables BEFORE importing routes
dotenv.config();

const convertRoute = require('./routes/convert');
const { getPerformanceMetrics, resetPerformanceMetrics } = require('./services/ollamaService');

const app = express();
const PORT = process.env.PORT || 6001;
const JSON_LIMIT = process.env.JSON_LIMIT || '1mb';
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
function normalizeOrigin(value) {
  return (value || '').trim().replace(/\/+$/, '').toLowerCase();
}

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => normalizeOrigin(s))
  .filter(Boolean);

app.use(
  cors(
    ALLOWED_ORIGINS.length
      ? {
          origin(origin, callback) {
            const normalizedOrigin = normalizeOrigin(origin);
            if (!origin || ALLOWED_ORIGINS.includes(normalizedOrigin)) {
              callback(null, true);
              return;
            }
            callback(new Error('CORS origin not allowed'));
          }
        }
      : undefined
  )
);
app.use(express.json({ limit: JSON_LIMIT }));

app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    console.log(
      JSON.stringify({
        level: 'info',
        type: 'http_request',
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs
      })
    );
  });
  next();
});

const apiRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please retry shortly.'
  }
});

app.use('/api/convert', apiRateLimiter, convertRoute);

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'AI Code Translator API is running' });
});

app.get('/health/perf', (req, res) => {
  res.json({ success: true, metrics: getPerformanceMetrics() });
});

app.post('/health/perf/reset', (req, res) => {
  resetPerformanceMetrics();
  res.json({ success: true, message: 'Performance metrics reset' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
