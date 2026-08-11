const { createClient } = require('redis');
const fs = require('fs');
const path = require('path');

/**
 * Redis client wrapper for rate limiting operations
 * Handles connection, script loading, and rate limit checks
 */
class RateLimitRedisClient {
  constructor() {
    this.client = null;
    this.scriptSha = null;
    this.isConnected = false;
  }

  /**
   * Initialize Redis connection and load Lua script
   */
  async connect() {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = process.env.REDIS_PORT || 6379;

    this.client = createClient({
      socket: {
        host: redisHost,
        port: redisPort,
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.error('[Redis] Max reconnection attempts reached');
            return new Error('Redis connection failed');
          }
          return Math.min(retries * 100, 3000);
        }
      }
    });

    // Error handling
    this.client.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
      this.isConnected = false;
    });

    this.client.on('connect', () => {
      console.log('[Redis] Connected');
    });

    this.client.on('ready', () => {
      console.log('[Redis] Ready');
      this.isConnected = true;
    });

    this.client.on('reconnecting', () => {
      console.log('[Redis] Reconnecting...');
      this.isConnected = false;
    });

    // Connect to Redis
    await this.client.connect();

    // Load the Lua script
    await this.loadScript();

    return this;
  }

  /**
   * Load sliding window Lua script into Redis
   * Returns SHA that can be used with EVALSHA for performance
   */
  async loadScript() {
    const scriptPath = path.join(__dirname, 'scripts', 'sliding-window.lua');
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');

    try {
      this.scriptSha = await this.client.scriptLoad(scriptContent);
      console.log(`[Redis] Lua script loaded with SHA: ${this.scriptSha}`);
    } catch (err) {
      console.error('[Redis] Failed to load Lua script:', err);
      throw err;
    }
  }

  /**
   * Check rate limit for a customer
   *
   * @param {string} customerId - Customer identifier
   * @param {number} maxRequests - Maximum requests allowed in window
   * @param {string} requestId - Unique request ID (UUID)
   * @param {number} windowSeconds - Window size in seconds (default: 60)
   * @returns {Promise<{allowed: boolean, count: number, timestamp: number}>}
   */
  async checkLimit(customerId, maxRequests, requestId, windowSeconds = 60) {
    if (!this.isConnected || !this.client) {
      throw new Error('Redis client not connected');
    }

    const key = `ratelimit:${customerId}`;
    const windowMicroseconds = windowSeconds * 1000000;

    try {
      // Call the Lua script using EVALSHA (more efficient than EVAL)
      const result = await this.client.evalSha(
        this.scriptSha,
        {
          keys: [key],
          arguments: [
            windowMicroseconds.toString(),
            maxRequests.toString(),
            requestId
          ]
        }
      );

      // Parse result: [allowed, count, timestamp]
      return {
        allowed: result[0] === 1,
        count: result[1],
        timestamp: result[2]
      };
    } catch (err) {
      // If script not found, reload and retry once
      if (err.message.includes('NOSCRIPT')) {
        console.warn('[Redis] Script not found, reloading...');
        await this.loadScript();
        return this.checkLimit(customerId, maxRequests, requestId, windowSeconds);
      }
      throw err;
    }
  }

  /**
   * Get current request count for a customer (for debugging)
   */
  async getCurrentCount(customerId) {
    const key = `ratelimit:${customerId}`;
    return await this.client.zCard(key);
  }

  /**
   * Disconnect from Redis
   */
  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.isConnected = false;
      console.log('[Redis] Disconnected');
    }
  }

  /**
   * Check if Redis is available
   */
  async ping() {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (err) {
      return false;
    }
  }
}

module.exports = RateLimitRedisClient;
