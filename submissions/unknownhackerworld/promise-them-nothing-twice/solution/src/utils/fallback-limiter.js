/**
 * Local in-memory fallback rate limiter
 *
 * Used when Redis is unavailable. Implements conservative per-node limiting
 * to prevent quota violations during degraded mode.
 *
 * Per CTO requirement: "prefer rejecting extra legitimate requests over
 * allowing quota violations"
 *
 * Strategy: Each node independently enforces (configured_rpm / MAX_NODES)
 * This ensures global quota is never exceeded even if traffic is skewed
 * to a single node.
 */
class FallbackLimiter {
  constructor() {
    // MAX_NODES: pessimistic ceiling for cluster size
    // Set higher than current node count (3) to remain safe during scale-up
    this.MAX_NODES = parseInt(process.env.MAX_NODES || '5', 10);

    // Store per-customer request timestamps
    // Structure: { customerId: [timestamp1, timestamp2, ...] }
    this.windows = new Map();

    // Window size in milliseconds
    this.WINDOW_MS = 60 * 1000; // 60 seconds

    // Cleanup interval to prevent memory leaks
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 30000); // Clean up every 30 seconds

    console.log(`[FallbackLimiter] Initialized with MAX_NODES=${this.MAX_NODES}`);
  }

  /**
   * Check if request is allowed under conservative per-node limit
   *
   * @param {string} customerId - Customer identifier
   * @param {number} configuredRpm - Customer's configured RPM limit
   * @returns {{allowed: boolean, count: number, limit: number}}
   */
  checkLimit(customerId, configuredRpm) {
    const now = Date.now();

    // Calculate conservative per-node limit
    // Divide by MAX_NODES (not actual node count) to be deliberately pessimistic
    const perNodeLimit = Math.floor(configuredRpm / this.MAX_NODES);

    // Get or create window for this customer
    if (!this.windows.has(customerId)) {
      this.windows.set(customerId, []);
    }

    const window = this.windows.get(customerId);

    // Remove expired timestamps (outside the sliding window)
    const windowStart = now - this.WINDOW_MS;
    const activeRequests = window.filter(timestamp => timestamp > windowStart);

    // Update the window with only active requests
    this.windows.set(customerId, activeRequests);

    const currentCount = activeRequests.length;

    // Check if limit exceeded
    if (currentCount >= perNodeLimit) {
      return {
        allowed: false,
        count: currentCount,
        limit: perNodeLimit
      };
    }

    // Allow request - add current timestamp
    activeRequests.push(now);
    this.windows.set(customerId, activeRequests);

    return {
      allowed: true,
      count: currentCount + 1,
      limit: perNodeLimit
    };
  }

  /**
   * Periodic cleanup to prevent memory leaks
   * Remove customers with no recent activity
   */
  cleanup() {
    const now = Date.now();
    const windowStart = now - this.WINDOW_MS;
    let cleaned = 0;

    for (const [customerId, window] of this.windows.entries()) {
      // Remove customers with no requests in the last window
      if (window.length === 0 || window.every(ts => ts < windowStart)) {
        this.windows.delete(customerId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[FallbackLimiter] Cleaned up ${cleaned} inactive customer windows`);
    }
  }

  /**
   * Get current count for a customer (for debugging)
   */
  getCurrentCount(customerId) {
    if (!this.windows.has(customerId)) {
      return 0;
    }

    const now = Date.now();
    const windowStart = now - this.WINDOW_MS;
    const window = this.windows.get(customerId);

    return window.filter(timestamp => timestamp > windowStart).length;
  }

  /**
   * Clear all data (for testing)
   */
  reset() {
    this.windows.clear();
  }

  /**
   * Stop cleanup interval
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

module.exports = FallbackLimiter;
