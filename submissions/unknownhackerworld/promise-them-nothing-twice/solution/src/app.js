const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { csrfProtection, csrfTokenHandler } = require('./middleware/csrf-protection');
const { createRateLimiter } = require('./middleware/rate-limiter');

/**
 * Create Express application with rate limiting middleware
 *
 * @param {Object} redisClient - RateLimitRedisClient instance
 * @param {Object} fallbackLimiter - Optional local fallback limiter
 * @returns {Express} Express app instance
 */
function createApp(redisClient, fallbackLimiter = null) {
  const app = express();

  // Security headers: X-Content-Type-Options, X-Frame-Options,
  // Strict-Transport-Security, Content-Security-Policy, etc.
  app.use(helmet());

  // Parse JSON bodies
  app.use(express.json());

  // Required by csrf-protection middleware to read the _csrf_secret cookie
  app.use(cookieParser());

  // CSRF protection for all state-changing requests (POST/PUT/PATCH/DELETE).
  // GET requests are safe by HTTP definition and are skipped automatically.
  // See src/middleware/csrf-protection.js for the double-submit cookie scheme.
  app.use(csrfProtection);

  // Issues a CSRF secret + token pair for clients that need to make
  // state-changing requests. Not rate-limited so infra tooling can always reach it.
  app.get('/csrf-token', csrfTokenHandler);

  // Health check endpoint (before rate limiting to allow monitoring)
  app.get('/health', (req, res) => {
    const redisConnected = redisClient ? redisClient.isConnected : false;
    res.json({
      status: 'ok',
      redis: redisConnected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString()
    });
  });

  // Request logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const customerId = req.headers['x-customer-id'] || 'unknown';
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${req.path} | ` +
        `customer=${customerId} | status=${res.statusCode} | ${duration}ms`
      );
    });
    next();
  });

  // Apply rate limiting to all routes
  app.use(createRateLimiter(redisClient, fallbackLimiter));

  // Demo resource endpoint
  app.get('/api/v1/resource', (req, res) => {
    res.json({
      message: 'Request successful',
      data: {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toISOString(),
        customer: req.headers['x-customer-id']
      },
      rateLimit: req.rateLimitInfo
    });
  });

  // Ping endpoint for testing
  app.get('/api/v1/ping', (req, res) => {
    res.json({
      message: 'pong',
      timestamp: new Date().toISOString(),
      rateLimit: req.rateLimitInfo
    });
  });

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not Found',
      message: `Route ${req.method} ${req.path} not found`
    });
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error('[App] Unhandled error:', err);
    res.status(500).json({
      error: 'Internal Server Error',
      message: err.message
    });
  });

  return app;
}

module.exports = createApp;
