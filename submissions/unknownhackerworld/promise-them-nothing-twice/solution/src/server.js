require('dotenv').config();
const createApp = require('./app');
const RateLimitRedisClient = require('./redis/client');

const PORT = process.env.PORT || 3000;

/**
 * Initialize and start the server
 */
async function start() {
  console.log('[Server] Starting RelayAPI Rate Limiter...');
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);

  let redisClient = null;
  let fallbackLimiter = null;

  try {
    // Initialize Redis client
    redisClient = new RateLimitRedisClient();
    await redisClient.connect();
    console.log('[Server] Redis client initialized');
  } catch (err) {
    console.error('[Server] Failed to connect to Redis:', err.message);
    console.warn('[Server] Will attempt fallback mode if available');

    // Load fallback limiter if Redis fails
    try {
      const FallbackLimiter = require('./utils/fallback-limiter');
      fallbackLimiter = new FallbackLimiter();
      console.log('[Server] Fallback limiter initialized');
    } catch (fallbackErr) {
      console.error('[Server] Fallback limiter not available');
    }
  }

  // Create Express app with rate limiting
  const app = createApp(redisClient, fallbackLimiter);

  // Start HTTP server
  const server = app.listen(PORT, () => {
    console.log(`[Server] Listening on port ${PORT}`);
    console.log(`[Server] Health check: http://localhost:${PORT}/health`);
    console.log(`[Server] Resource endpoint: http://localhost:${PORT}/api/v1/resource`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[Server] ${signal} received, shutting down gracefully...`);

    server.close(() => {
      console.log('[Server] HTTP server closed');
    });

    if (redisClient) {
      await redisClient.disconnect();
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Handle unhandled rejections
process.on('unhandledRejection', (err) => {
  console.error('[Server] Unhandled rejection:', err);
  process.exit(1);
});

// Start the server
start().catch((err) => {
  console.error('[Server] Fatal error during startup:', err);
  process.exit(1);
});
