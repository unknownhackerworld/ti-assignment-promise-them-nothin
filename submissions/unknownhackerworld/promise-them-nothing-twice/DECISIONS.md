# Decisions — Promise Them Nothing Twice

## Conflict resolution

The CTO demands "never exceed quota" with "no special-case hacks." Support demands "Northwind must never see 429 during batch." These requirements are mutually exclusive if treated literally.

**Resolution**: The CTO explicitly provided the escape hatch: "If we ever grant a commercial exception, it goes through config and audit — not a midnight commit."

I implemented **config-driven scheduled quota overrides** — any Enterprise customer can have time-based elevated limits stored in `policies.json`. Northwind's batch window (02:00–04:00 UTC, 1500 RPM) is configured, auditable, and uses the same code path as the base limit. No `if (customerId === 'northwind')` bypass exists.

**What I rejected**:
- Silently allowing violations: violates CTO's core invariant
- Hardcoded customer bypass: violates "strictly fair" and "auditable"
- "We'll tell them to spread requests": Support explicitly ruled this out
- Soft warnings instead of 429s: CTO explicitly rejected for v1

The commercial team still needs to amend Northwind's contract to reflect their batch-window tier, but the system architecture supports the resolution without technical debt.

## Technical design

**Algorithm**: Exact sliding window log using Redis sorted sets
- Why not fixed window? Allows burst at boundaries (customer can send 300 at 00:59:59 and 300 at 01:00:01)
- Why not weighted counter? Harder to audit ("we estimated based on interpolation...")
- Why not token bucket? Doesn't expose "requests in last 60s" count for customer-facing headers

**Distributed coordination**:
- Lua script in Redis makes check-and-admit atomic (no races between 3 nodes)
- `redis.call('TIME')` as single clock source eliminates cross-node clock skew
- Request ID passed from app (UUID) prevents collisions at same microsecond

**Failure mode** (Redis unavailable):
- Degrade to `rpm / MAX_NODES` per-node local limit
- MAX_NODES = 5 (higher than actual 3) to be deliberately pessimistic
- Honors "prefer under-limit over over-limit" — never violates quota even during degraded mode
- Does NOT fail open (CTO requirement: "I would rather reject extra than allow violations")

**Tradeoffs accepted**:
- Single Redis = single point of failure (should be Sentinel/Cluster for production)
- No dynamic config reload (requires restart to change policies)
- Memory: O(requests per window per customer) in Redis — manageable at documented scale (1500 RPM = 1500 entries = ~50KB per customer)

## Verification

**What the harness proves**:
- ✓ Customer at exact quota (300 RPM) gets all requests allowed
- ✓ Customer exceeding quota (400 RPM) gets ~300 allowed, ~100 rejected (429)
- ✓ Two customers on same tier don't interfere (isolation)
- ✓ Northwind's scheduled override works (1500 RPM during batch window, 300 outside)
- ✓ Distributed enforcement: limit holds even when hammering load balancer across 3 nodes

**What it does NOT prove**:
- ✗ Correctness at Northwind's actual scale (800–1200 RPM sustained for 2 hours)
- ✗ Exact behavior at schedule boundary (e.g., 01:59:59 → 02:00:00) under high load
- ✗ Redis failover/cluster resilience (single Redis instance in demo)
- ✗ Performance beyond ~500 RPS (not load tested with proper tooling like k6/Gatling)
- ✗ Retry-After header accuracy (returns full window duration, not exact time to next slot)

The harness is a **correctness proof**, not a production validation. Boundary cases (clock transitions, Redis split-brain, retry amplification) need dedicated chaos testing.

## If I had four more hours

1. **Chaos test the schedule boundary**: Spawn 1200 RPM load starting at 01:59:50, validate no 429s leak into the batch window and no over-admissions leak out. This is where the "single clock source" design would prove its value.

2. **Redis Cluster + Sentinel**: Replace single Redis with a 3-node cluster. Prove the system survives Redis node failure without data loss or quota violations.

3. **Observability**: Add Prometheus metrics (`ratelimit_requests_total`, `ratelimit_429s_total`, `ratelimit_fallback_active`) and a Grafana dashboard. The CTO wants to explain counting semantics — a real-time graph of "requests in current window" per customer is worth a thousand words.

4. **Graduated response headers**: Return `X-RateLimit-Reset` (epoch timestamp of oldest request expiring) so smart clients can retry at the exact right moment instead of waiting the full 60s `Retry-After`.

5. **Dynamic config reload**: Watch `policies.json` for changes (or move to Postgres with a `/reload` admin endpoint). Support shouldn't need to restart 3 app nodes + LB to change Northwind's schedule.
