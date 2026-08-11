const { v4: uuidv4 } = require('uuid');
const policies = require('../config/policies.json');

/**
 * Get effective RPM limit for a customer at the current time
 * Checks if customer has active scheduled overrides
 *
 * @param {string} customerId - Customer identifier
 * @param {Date} now - Current timestamp
 * @returns {number} - Effective RPM limit
 */
function getEffectiveLimit(customerId, now = new Date()) {
  const customerPolicy = policies.customers[customerId];

  if (!customerPolicy) {
    // Unknown customer - default to minimal limit
    return 60;
  }

  // Check if customer has any active scheduled overrides
  if (customerPolicy.schedules && customerPolicy.schedules.length > 0) {
    const currentHour = now.getUTCHours();
    const currentMinute = now.getUTCMinutes();
    const currentTimeInMinutes = currentHour * 60 + currentMinute;

    for (const schedule of customerPolicy.schedules) {
      const [startHour, startMinute] = schedule.start_time.split(':').map(Number);
      const [endHour, endMinute] = schedule.end_time.split(':').map(Number);

      const startTimeInMinutes = startHour * 60 + startMinute;
      const endTimeInMinutes = endHour * 60 + endMinute;

      // Check if current time falls within the schedule window
      if (currentTimeInMinutes >= startTimeInMinutes && currentTimeInMinutes < endTimeInMinutes) {
        return schedule.rpm;
      }
    }
  }

  // No active schedule, return base RPM
  return customerPolicy.base_rpm;
}

/**
 * Calculate Retry-After header value (in seconds)
 * Based on how long until the next request would be allowed
 *
 * @param {number} windowSeconds - Rate limit window size
 * @returns {number} - Seconds to wait
 */
function calculateRetryAfter(windowSeconds = 60) {
  // Conservative estimate: wait for the full window to reset
  // In a real system, could calculate exact time based on oldest request in window
  return windowSeconds;
}

/**
 * Rate limiter middleware factory
 * Creates Express middleware that enforces per-customer rate limits
 *
 * @param {Object} redisClient - RateLimitRedisClient instance
 * @param {Object} fallbackLimiter - Optional local fallback limiter
 * @returns {Function} Express middleware
 */
function createRateLimiter(redisClient, fallbackLimiter = null) {
  return async (req, res, next) => {
    const customerId = req.headers['x-customer-id'];

    // Reject requests without customer ID
    if (!customerId) {
      return res.status(401).json({
        error: 'Missing X-Customer-Id header',
        message: 'All requests must include a valid customer identifier'
      });
    }

    // Generate unique request ID for this request
    const requestId = uuidv4();
    req.requestId = requestId;

    // Get effective limit for this customer at this time
    const effectiveLimit = getEffectiveLimit(customerId);
    const windowSeconds = 60;

    try {
      // Try Redis-based rate limiting first
      if (redisClient && redisClient.isConnected) {
        const result = await redisClient.checkLimit(
          customerId,
          effectiveLimit,
          requestId,
          windowSeconds
        );

        // Add rate limit info to response headers
        res.setHeader('X-RateLimit-Limit', effectiveLimit);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, effectiveLimit - result.count));
        res.setHeader('X-RateLimit-Window', `${windowSeconds}s`);

        if (!result.allowed) {
          // Rate limit exceeded
          const retryAfter = calculateRetryAfter(windowSeconds);
          res.setHeader('Retry-After', retryAfter);

          return res.status(429).json({
            error: 'Too Many Requests',
            message: `Rate limit of ${effectiveLimit} requests per ${windowSeconds}s exceeded`,
            retry_after: retryAfter,
            current_count: result.count
          });
        }

        // Request allowed
        req.rateLimitInfo = {
          customerId,
          limit: effectiveLimit,
          count: result.count,
          remaining: effectiveLimit - result.count,
          timestamp: result.timestamp,
          source: 'redis'
        };

        return next();
      }

      // Fallback to local rate limiting if Redis unavailable
      if (fallbackLimiter) {
        const fallbackResult = fallbackLimiter.checkLimit(customerId, effectiveLimit);

        res.setHeader('X-RateLimit-Limit', effectiveLimit);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, effectiveLimit - fallbackResult.count));
        res.setHeader('X-RateLimit-Window', `${windowSeconds}s`);
        res.setHeader('X-RateLimit-Source', 'fallback');

        if (!fallbackResult.allowed) {
          const retryAfter = calculateRetryAfter(windowSeconds);
          res.setHeader('Retry-After', retryAfter);

          return res.status(429).json({
            error: 'Too Many Requests',
            message: `Rate limit exceeded (degraded mode: ${fallbackResult.limit} RPM)`,
            retry_after: retryAfter,
            degraded: true
          });
        }

        req.rateLimitInfo = {
          customerId,
          limit: fallbackResult.limit,
          count: fallbackResult.count,
          source: 'fallback'
        };

        return next();
      }

      // No rate limiting available - fail closed per CTO requirement
      console.error('[RateLimiter] No rate limiting backend available');
      return res.status(503).json({
        error: 'Service Unavailable',
        message: 'Rate limiting service is unavailable'
      });

    } catch (err) {
      console.error('[RateLimiter] Error:', err);

      // On error, fail closed (reject request) per CTO's "prefer under-limit" directive
      return res.status(503).json({
        error: 'Service Unavailable',
        message: 'Rate limiting error occurred'
      });
    }
  };
}

module.exports = {
  createRateLimiter,
  getEffectiveLimit
};
