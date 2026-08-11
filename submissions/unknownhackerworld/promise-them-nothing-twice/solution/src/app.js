const express = require('express');
const helmet = require('helmet');
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

  // Security headers: sets X-Content-Type-Options, X-Frame-Options,
  // Strict-Transport-Security, Content-Security-Policy, etc.
  app.use(helmet());

  // CSRF note: this is a stateless machine-to-machine API authenticated via
  // the X-Customer-Id header (injected by the API gateway, never by a browser).
  // There are no cookies or session tokens, so browser-based CSRF attacks have
  // no attack surface. Traditional CSRF tokens are therefore not applicable here.
  // Helmet's Content-Security-Policy and X-Frame-Options headers further reduce
  // any residual cross-origin risk.

  // Parse JSON bodies
  app.use(express.json());

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
