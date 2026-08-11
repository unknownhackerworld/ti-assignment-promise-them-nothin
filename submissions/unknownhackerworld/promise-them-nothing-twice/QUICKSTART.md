# Quick Start Guide

Get the rate limiter running in under 5 minutes.

## Prerequisites

- Docker Desktop (with docker-compose)
- Node.js 18+ (for load tests)

## Step 1: Build and Start (2 min)

```bash
cd solution
docker-compose up --build
```

Wait for:
```
relayapi-app-1    | [Server] Listening on port 3000
relayapi-app-2    | [Server] Listening on port 3000
relayapi-app-3    | [Server] Listening on port 3000
relayapi-lb       | ... started
```

## Step 2: Verify Health (30 sec)

```bash
curl http://localhost:8080/health
```

Expected:
```json
{
  "status": "ok",
  "redis": "connected",
  "timestamp": "..."
}
```

## Step 3: Test Single Request (30 sec)

```bash
curl -H "X-Customer-Id: customer-a" http://localhost:8080/api/v1/ping
```

Expected: 200 OK with rate limit headers

## Step 4: Run Load Tests (2 min)

```bash
npm install
npm test
```

Expected output:
```
======================================================================
Test 1: Customer-A at 300 RPM (exact quota)
======================================================================
✓ PASS Customer-A should be allowed up to quota
  Total: 300 | Allowed: 300 (100.0%) | Rejected: 0 (0.0%)

...

Total: 5 tests | Passed: 5 | Failed: 0
```

## Done!

You now have:
- 3 stateless app nodes behind nginx
- Redis-coordinated distributed rate limiting
- Northwind's scheduled batch window override
- Verified correctness at quota boundaries

## Next Steps

- Read `solution/README.md` for detailed documentation
- Read `DECISIONS.md` for design rationale
- Check `sessions/01-implementation.md` for full context

## Troubleshooting

**Port 8080 in use?**
```bash
# Change nginx port in docker-compose.yml:
ports:
  - "9090:80"  # Use 9090 instead
```

**Tests failing?**
```bash
# Wait for rate limit windows to reset
sleep 65
npm test
```

**Redis not connecting?**
```bash
docker-compose logs redis
docker-compose restart redis
```
