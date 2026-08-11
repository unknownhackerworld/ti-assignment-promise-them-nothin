# RelayAPI Rate Limiter

Per-customer distributed rate limiter with scheduled quota overrides.

## Architecture

- **Algorithm**: Exact sliding window using Redis sorted sets
- **Coordination**: Redis Lua script (atomic operations, single clock source)
- **Deployment**: 3 stateless Node.js app nodes behind nginx load balancer
- **Fallback**: Conservative per-node local limiting when Redis unavailable

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for local testing only)

### 1. Start the Multi-Node System

```bash
# Build and start all services (3 app nodes + Redis + nginx)
docker-compose up --build

# Wait for all services to be healthy (~10 seconds)
```

This starts:
- **Redis** on port 6379 (shared state)
- **App Node 1, 2, 3** (internal network)
- **Nginx Load Balancer** on port 8080

### 2. Verify System Health

```bash
curl http://localhost:8080/health
```

Expected output:
```json
{
  "status": "ok",
  "redis": "connected",
  "timestamp": "2026-03-14T..."
}
```

### 3. Test Single Request

```bash
# Customer-A request (300 RPM quota)
curl -H "X-Customer-Id: customer-a" http://localhost:8080/api/v1/ping

# Expected: 200 OK with rate limit headers
```

### 4. Run Load Test Harness

```bash
# Install dependencies (if not already done)
npm install

# Run comprehensive load tests
npm test

# Or directly:
node tests/load-test.js
```

The harness validates:
- ✓ Customer at exact quota (300 RPM)
- ✓ Customer exceeding quota gets 429s
- ✓ Two customers don't interfere (isolation)
- ✓ Northwind's scheduled override (batch window)
- ✓ Distributed enforcement across 3 nodes

**Expected runtime**: ~30-60 seconds

## Configuration

### Customer Policies

Edit `src/config/policies.json`:

```json
{
  "customers": {
    "northwind": {
      "base_rpm": 300,
      "schedules": [
        {
          "name": "Nightly batch window",
          "start_time": "02:00",
          "end_time": "04:00",
          "timezone": "UTC",
          "rpm": 1500
        }
      ]
    }
  }
}
```

**No code changes needed** — schedule overrides are config-driven and auditable.

### Environment Variables

```bash
REDIS_HOST=redis      # Redis hostname
REDIS_PORT=6379       # Redis port
PORT=3000             # App server port
MAX_NODES=5           # Pessimistic node count for fallback mode
```

## Testing Phases

Each phase is independently testable:

### Phase 1: Config & Redis

```bash
docker-compose up redis
docker-compose config  # Validate compose file
```

### Phase 2: Lua Script

```bash
# Start Redis
docker-compose up redis

# Test Lua script directly
docker exec relayapi-redis redis-cli EVAL "$(cat src/redis/scripts/sliding-window.lua)" 1 test:key 60000000 5 req-1

# Expected output: [1, 1, <timestamp>]
```

### Phase 3: Redis Client (Local Development)

```bash
# Create .env file
cp .env.example .env

# Update REDIS_HOST to localhost in .env
# Then start single instance:
npm install
REDIS_HOST=localhost node src/server.js
```

### Phase 4: Single Instance Testing

```bash
# With server running (from Phase 3):
curl -H "X-Customer-Id: customer-a" http://localhost:3000/api/v1/ping

# Repeat 300 times to hit limit
for i in {1..350}; do
  curl -s -H "X-Customer-Id: customer-a" http://localhost:3000/api/v1/ping | jq .
done
```

### Phase 5: Fallback Mode

```bash
# Start app, then kill Redis
docker-compose up app-node-1
docker-compose stop redis

# Send requests - should get conservative 429s, not crashes
curl -H "X-Customer-Id: customer-a" http://localhost:3000/api/v1/ping
```

### Phase 6: Multi-Node (Full Stack)

```bash
# Start entire stack
docker-compose up --build

# Verify load balancing
for i in {1..10}; do
  curl -H "X-Customer-Id: customer-a" http://localhost:8080/api/v1/ping
done

# Check logs - should see requests hitting different nodes
docker-compose logs | grep "customer-a"
```

### Phase 7: Load Harness

```bash
npm test
```

## API Reference

### Endpoints

#### `GET /api/v1/ping`
Demo endpoint for testing rate limits.

**Headers:**
- `X-Customer-Id` (required): Customer identifier

**Response (200 OK):**
```json
{
  "message": "pong",
  "timestamp": "2026-03-14T...",
  "rateLimit": {
    "customerId": "customer-a",
    "limit": 300,
    "count": 42,
    "remaining": 258
  }
}
```

**Response (429 Too Many Requests):**
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit of 300 requests per 60s exceeded",
  "retry_after": 60,
  "current_count": 305
}
```

**Headers:**
- `X-RateLimit-Limit`: Configured limit
- `X-RateLimit-Remaining`: Requests remaining in window
- `X-RateLimit-Window`: Window size (e.g., "60s")
- `Retry-After`: Seconds until retry (on 429 only)

### Customers

| Customer ID | Base RPM | Schedule Override | Notes |
|-------------|----------|-------------------|-------|
| `customer-a` | 300 | None | Starter tier |
| `customer-b` | 300 | None | Growth tier |
| `northwind` | 300 | 1500 RPM during 02:00-04:00 UTC | Enterprise (60% ARR) |

## Design Decisions

### 1. Conflict Resolution

**CTO requirement**: Hard enforcement, no special-case code bypasses  
**Support requirement**: Northwind must never see 429 during batch

**Solution**: Config-driven scheduled quota overrides
- Northwind doesn't get a bypass — they get an explicitly configured elevated tier during their batch window
- Same mechanism available to any Enterprise customer
- Auditable via config file and logs
- Satisfies "config and audit, not a midnight commit"

### 2. Algorithm: Sliding Window Log

**Why not fixed window?** Allows bursty traffic at window boundaries  
**Why not weighted counter?** Harder to audit ("we interpolated...")  
**Why sliding window log?** Exact counting, explainable in one paragraph

Implementation:
- Redis sorted set: `ZADD` (add request), `ZREMRANGEBYSCORE` (expire old), `ZCARD` (count)
- Score = timestamp in microseconds
- Member = UUID from app (no collision risk)
- All operations in one atomic Lua script

### 3. Distributed Coordination

**Single clock source**: All nodes call `redis.call('TIME')` in Lua script — eliminates clock skew  
**Atomic operations**: Entire check-and-admit is one Redis command  
**No race conditions**: Lua script is serialized by Redis

**Failure mode (Redis down)**: Degrade to local per-node limit
- `effective_limit = configured_rpm / MAX_NODES`
- MAX_NODES set to 5 (higher than actual 3) to be deliberately pessimistic
- Honors CTO's "prefer under-limit over over-limit"

### 4. Schedule Evaluation

Time-based overrides evaluated **in Lua script using Redis TIME** — not app-layer clocks.

This prevents:
- Clock skew causing inconsistent limit at 02:00:00 boundary
- One node applying elevated limit while another applies base limit

### 5. Request ID Strategy

**Problem**: `math.random()` in Lua is non-deterministic (breaks script replication) and causes collisions at high RPS  
**Solution**: Pass UUID from app layer as `ARGV[3]`
- Guaranteed unique (UUID v4)
- Deterministic (it's an input to the script)
- Traceable in audit logs

## CTO Demo Scenario

> "Show me a demo where two customers on a 100 RPM tier each get exactly their budget, and a third customer who exceeds 100 RPM gets cut off — even when I hammer the load balancer randomly across all three nodes."

Adapt `policies.json` to 100 RPM tiers, then:

```bash
# Start the stack
docker-compose up --build

# Run load test
npm test
```

Output will show:
- Customer-A and Customer-B each get ~100 requests allowed (isolation)
- Customer attempting 150 RPM gets ~100 allowed + ~50 rejected
- Global limit enforced despite round-robin across 3 nodes

## Troubleshooting

### Redis connection refused
```bash
# Check Redis is running
docker-compose ps

# Check Redis health
docker exec relayapi-redis redis-cli ping
```

### All requests getting 429
```bash
# Check policies.json is mounted
docker exec relayapi-app-1 cat src/config/policies.json

# Check Redis keys
docker exec relayapi-redis redis-cli KEYS "ratelimit:*"

# Reset Redis state
docker exec relayapi-redis redis-cli FLUSHALL
```

### Load balancer not distributing traffic
```bash
# Check nginx config
docker exec relayapi-lb cat /etc/nginx/nginx.conf

# Check nginx logs
docker-compose logs nginx

# Verify all app nodes are up
docker-compose ps
```

### Test harness failures
```bash
# Wait 60s for rate limit windows to reset
sleep 60 && npm test

# Run against single node (bypass LB)
TEST_URL=http://localhost:3000 npm test
```

## Cleanup

```bash
# Stop all services
docker-compose down

# Remove volumes (reset Redis data)
docker-compose down -v

# Remove images
docker-compose down --rmi all
```

## Project Structure

```
solution/
├── docker-compose.yml       # Multi-node deployment
├── Dockerfile               # App container image
├── nginx.conf               # Load balancer config
├── package.json             # Dependencies
├── src/
│   ├── server.js            # Entry point
│   ├── app.js               # Express app setup
│   ├── config/
│   │   └── policies.json    # Customer rate limit policies
│   ├── middleware/
│   │   └── rate-limiter.js  # Rate limiting middleware
│   ├── redis/
│   │   ├── client.js        # Redis client wrapper
│   │   └── scripts/
│   │       └── sliding-window.lua  # Atomic rate limit script
│   └── utils/
│       └── fallback-limiter.js     # Local fallback (Redis down)
└── tests/
    └── load-test.js         # Load test harness
```

## What This Proves

✓ Hard per-customer quota enforcement  
✓ Works across 3 stateless nodes (distributed correctness)  
✓ Customer isolation (no quota sharing)  
✓ Config-driven exceptions (Northwind batch window)  
✓ Auditable (one-paragraph algorithm explanation)  
✓ Fail-safe degradation (Redis outage → conservative local limit)  
✓ Single clock source (no boundary race conditions)  
✓ No collision risk (UUID-based request IDs)

## What This Does NOT Prove

✗ Performance at scale (not load tested beyond ~500 RPS)  
✗ Cluster failover (single Redis instance)  
✗ Dynamic config reload (requires restart)  
✗ Billing integration (out of scope per assignment)  
✗ Customer dashboard (out of scope per assignment)

## Next Steps (If I Had 4 More Hours)

1. **Redis Sentinel/Cluster**: Add HA for production
2. **Metrics & Observability**: Prometheus + Grafana dashboard
3. **Dynamic Config**: Reload policies without restart (watch file or Postgres)
4. **Graduated response**: Return `X-RateLimit-Reset` timestamp for smarter client retries
5. **Performance testing**: Validate at 10K+ RPS with proper load generator

---

**Total implementation time**: ~4-5 hours  
**Session exports**: See `../sessions/` directory
