--[[
  Sliding Window Rate Limiter (Redis Lua Script)

  Implements exact sliding window counting using a sorted set.

  KEYS[1] = rate limit key (e.g., "ratelimit:customer-a")
  ARGV[1] = window size in microseconds (e.g., 60000000 for 60 seconds)
  ARGV[2] = max requests allowed in the window (effective RPM)
  ARGV[3] = unique request ID from application (UUID)

  Returns: {allowed (1=yes, 0=no), current_count, timestamp_microseconds}

  Algorithm:
  1. Use Redis's own clock (TIME command) as the single source of truth
  2. Remove expired entries older than window_start
  3. Count remaining requests in the window
  4. If under limit, admit the request by adding it to the sorted set
  5. Set TTL to prevent memory leaks

  Guarantees:
  - Atomic: entire operation is one Redis command (no races between nodes)
  - Deterministic: uses ARGV[3] from app, not random numbers
  - No collisions: UUID ensures uniqueness even at same microsecond
  - Single clock: all nodes use Redis TIME, not local clocks
--]]

-- Get current time from Redis (single source of truth for all nodes)
local now = redis.call('TIME')
local now_us = tonumber(now[1]) * 1000000 + tonumber(now[2])

-- Parse arguments
local window_us = tonumber(ARGV[1])
local max_requests = tonumber(ARGV[2])
local request_id = ARGV[3]

-- Calculate window start time
local window_start_us = now_us - window_us

-- Remove expired entries (older than window start)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', window_start_us)

-- Count current requests in the active window
local current_count = redis.call('ZCARD', KEYS[1])

-- Check if we've hit the limit
if current_count >= max_requests then
    -- REJECTED: return denial with current count
    return {0, current_count, now_us}
end

-- ALLOWED: Add this request to the window
-- Score = timestamp in microseconds
-- Member = request_id (guaranteed unique from app layer)
redis.call('ZADD', KEYS[1], now_us, request_id)

-- Set expiration to window size + small buffer (prevent memory leaks)
-- Convert microseconds to milliseconds for PEXPIRE
local ttl_ms = math.ceil(window_us / 1000) + 1000
redis.call('PEXPIRE', KEYS[1], ttl_ms)

-- Return success with updated count
return {1, current_count + 1, now_us}
