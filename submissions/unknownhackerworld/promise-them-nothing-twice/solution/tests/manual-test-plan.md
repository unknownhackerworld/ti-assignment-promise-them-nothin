# Manual Black Box Testing Plan

**Target**: http://10.10.1.198:8080  
**Date**: 2026-08-11

## Prerequisites

```bash
# Ensure jq is installed for JSON parsing
sudo apt-get install jq -y

# Or test from Windows with curl
```

---

## Test Case 1: Health Check ✓

**Purpose**: Verify application is running and Redis is connected

```bash
curl http://10.10.1.198:8080/health | jq
```

**Expected**:
- HTTP 200
- `{"status":"ok","redis":"connected","timestamp":"..."}`

---

## Test Case 2: Missing Customer ID

**Purpose**: Verify authentication is required

```bash
curl -i http://10.10.1.198:8080/api/v1/ping
```

**Expected**:
- HTTP 401
- Error message about missing X-Customer-Id

---

## Test Case 3: Valid Request

**Purpose**: Basic functionality test

```bash
curl -H "X-Customer-Id: customer-a" http://10.10.1.198:8080/api/v1/ping | jq
```

**Expected**:
- HTTP 200
- Response includes `message: "pong"` and `rateLimit` info
- Headers include: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Window`

---

## Test Case 4: Rate Limit Headers

**Purpose**: Verify rate limit transparency

```bash
curl -i -H "X-Customer-Id: customer-a" http://10.10.1.198:8080/api/v1/ping | grep "X-RateLimit"
```

**Expected**:
```
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 299
X-RateLimit-Window: 60s
```

---

## Test Case 5: Hit Rate Limit

**Purpose**: Verify 429 is returned when limit exceeded

```bash
# Send 305 requests rapidly
for i in {1..305}; do
  curl -s -o /dev/null -w "%{http_code}\n" -H "X-Customer-Id: test-limit" http://10.10.1.198:8080/api/v1/ping
done | sort | uniq -c
```

**Expected**:
- ~300 responses with 200
- ~5 responses with 429

---

## Test Case 6: 429 Response Structure

**Purpose**: Verify 429 includes proper retry information

```bash
# Saturate limit first
for i in {1..310}; do curl -s -o /dev/null -H "X-Customer-Id: test-429" http://10.10.1.198:8080/api/v1/ping; done

# Get 429 response
curl -i -H "X-Customer-Id: test-429" http://10.10.1.198:8080/api/v1/ping
```

**Expected**:
- HTTP 429
- `Retry-After` header present
- JSON body with error message and retry_after field

---

## Test Case 7: Customer Isolation

**Purpose**: Verify two customers don't interfere with each other

Terminal 1:
```bash
# Saturate customer-a
for i in {1..310}; do 
  curl -s -o /dev/null -H "X-Customer-Id: customer-a" http://10.10.1.198:8080/api/v1/ping
done
```

Terminal 2 (run simultaneously):
```bash
# customer-b should still work
curl -H "X-Customer-Id: customer-b" http://10.10.1.198:8080/api/v1/ping | jq
```

**Expected**:
- customer-a gets 429
- customer-b gets 200 (not affected)

---

## Test Case 8: Northwind Base Limit (Outside Batch Window)

**Purpose**: Verify Northwind has 300 RPM outside 02:00-04:00 UTC

**Run only if**: Current UTC hour is NOT between 02:00-04:00

```bash
# Check current UTC time
date -u

# Test Northwind limit
for i in {1..350}; do
  curl -s -o /dev/null -w "%{http_code}\n" -H "X-Customer-Id: northwind" http://10.10.1.198:8080/api/v1/ping
done | sort | uniq -c
```

**Expected**:
- ~300 responses with 200
- ~50 responses with 429

---

## Test Case 9: Northwind Elevated Limit (Batch Window)

**Purpose**: Verify Northwind has 1500 RPM during 02:00-04:00 UTC

**Run only if**: Current UTC hour IS between 02:00-04:00

```bash
# Check current UTC time
date -u

# Test Northwind elevated limit
for i in {1..500}; do
  curl -s -o /dev/null -w "%{http_code}\n" -H "X-Customer-Id: northwind" http://10.10.1.198:8080/api/v1/ping
done | sort | uniq -c
```

**Expected**:
- All 500 responses should be 200 (no 429s)

---

## Test Case 10: Unknown Customer

**Purpose**: Verify unknown customers get minimal quota

```bash
curl -H "X-Customer-Id: unknown-xyz-123" http://10.10.1.198:8080/api/v1/ping | jq '.rateLimit.limit'
```

**Expected**:
- HTTP 200
- Limit should be 60 RPM (minimal/starter tier)

---

## Test Case 11: Distributed Enforcement

**Purpose**: Verify rate limiting works across all 3 nodes

```bash
# Send burst of 400 requests (will hit all 3 nodes via load balancer)
time for i in {1..400}; do
  curl -s -o /dev/null -w "%{http_code}\n" -H "X-Customer-Id: distributed-test" http://10.10.1.198:8080/api/v1/ping &
done | wait | sort | uniq -c
```

**Expected**:
- ~300 responses with 200
- ~100 responses with 429
- **Global limit enforced** (not 900 = 300×3 nodes)

---

## Test Case 12: Window Reset

**Purpose**: Verify limits reset after 60 seconds

```bash
# Saturate limit
for i in {1..310}; do curl -s -o /dev/null -H "X-Customer-Id: reset-test" http://10.10.1.198:8080/api/v1/ping; done

# Verify 429
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Customer-Id: reset-test" http://10.10.1.198:8080/api/v1/ping

# Wait 65 seconds
echo "Waiting 65 seconds for window reset..."
sleep 65

# Should work again
curl -H "X-Customer-Id: reset-test" http://10.10.1.198:8080/api/v1/ping | jq
```

**Expected**:
- First check: 429
- After 65s: 200 (limit reset)

---

## Test Case 13: Load Balancer Distribution

**Purpose**: Verify requests are distributed across all 3 nodes

```bash
# SSH to server and watch logs
ssh ai-server@10.10.1.198

# In another terminal, send requests
for i in {1..20}; do
  curl -s -H "X-Customer-Id: lb-test-$i" http://10.10.1.198:8080/api/v1/ping > /dev/null
  sleep 0.5
done

# Back on server, check which nodes handled requests
cd ~/Allen/solution
docker-compose logs --tail=20 app-node-1 | grep "lb-test"
docker-compose logs --tail=20 app-node-2 | grep "lb-test"
docker-compose logs --tail=20 app-node-3 | grep "lb-test"
```

**Expected**:
- Requests distributed across all 3 nodes (roughly equal)

---

## Test Case 14: Redis Failure (Fallback Mode)

**Purpose**: Verify system degrades gracefully when Redis fails

```bash
# SSH to server
ssh ai-server@10.10.1.198
cd ~/Allen/solution

# Stop Redis
docker-compose stop redis

# Test from another terminal - should still work (degraded mode)
curl -i -H "X-Customer-Id: fallback-test" http://10.10.1.198:8080/api/v1/ping

# Should see X-RateLimit-Source: fallback header

# Restart Redis
docker-compose start redis

# Wait 5 seconds
sleep 5

# Should return to normal mode
curl -i -H "X-Customer-Id: fallback-test" http://10.10.1.198:8080/api/v1/ping
```

**Expected**:
- Redis down: 200 OK, with `X-RateLimit-Source: fallback` header
- Conservative limit: 60 RPM (300/5 nodes)
- After Redis restart: normal operation resumes

---

## Test Case 15: Invalid Endpoint

**Purpose**: Verify 404 handling

```bash
curl -i -H "X-Customer-Id: customer-a" http://10.10.1.198:8080/api/v1/invalid
```

**Expected**:
- HTTP 404
- JSON error message

---

## Success Criteria

- [ ] All health checks pass
- [ ] Rate limiting enforced at correct boundaries
- [ ] 429 responses include Retry-After
- [ ] Customer isolation works
- [ ] Northwind schedule working (if in batch window)
- [ ] Unknown customers get minimal quota
- [ ] Distributed enforcement (not 3x limit)
- [ ] Load balanced across 3 nodes
- [ ] Graceful degradation when Redis fails
- [ ] Window resets after 60s

---

## Quick Test Commands

```bash
# Health
curl http://10.10.1.198:8080/health | jq

# Single request
curl -H "X-Customer-Id: customer-a" http://10.10.1.198:8080/api/v1/ping | jq

# Hit limit
for i in {1..310}; do curl -s -o /dev/null -w "%{http_code} " -H "X-Customer-Id: test" http://10.10.1.198:8080/api/v1/ping; done; echo

# Check headers
curl -i -H "X-Customer-Id: customer-a" http://10.10.1.198:8080/api/v1/ping | grep -E "HTTP|X-RateLimit"
```
