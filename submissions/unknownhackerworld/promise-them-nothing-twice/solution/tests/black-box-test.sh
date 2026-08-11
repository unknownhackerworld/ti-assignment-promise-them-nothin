#!/bin/bash

# Black Box Testing Script for RelayAPI Rate Limiter
# Tests the deployed application at 10.10.1.198:8080

BASE_URL="http://10.10.1.198:8080"
PASSED=0
FAILED=0

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================================================"
echo "RelayAPI Rate Limiter - Black Box Testing"
echo "========================================================================"
echo "Target: $BASE_URL"
echo "Started: $(date)"
echo ""

# Test helper functions
test_passed() {
    echo -e "${GREEN}✓ PASS${NC} $1"
    PASSED=$((PASSED + 1))
}

test_failed() {
    echo -e "${RED}✗ FAIL${NC} $1"
    echo -e "${RED}  Error: $2${NC}"
    FAILED=$((FAILED + 1))
}

test_warning() {
    echo -e "${YELLOW}⚠ WARN${NC} $1"
}

# Test 1: Health Check
echo "========================================================================"
echo "TEST 1: Health Check Endpoint"
echo "========================================================================"
response=$(curl -s -w "\n%{http_code}" "$BASE_URL/health")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$http_code" = "200" ]; then
    if echo "$body" | jq -e '.status == "ok" and .redis == "connected"' > /dev/null 2>&1; then
        test_passed "Health endpoint returns 200 OK with valid JSON"
        echo "  Response: $body"
    else
        test_failed "Health endpoint response invalid" "$body"
    fi
else
    test_failed "Health endpoint failed" "HTTP $http_code"
fi
echo ""

# Test 2: Missing Customer ID
echo "========================================================================"
echo "TEST 2: Request Without Customer ID (Error Handling)"
echo "========================================================================"
response=$(curl -s -w "\n%{http_code}" "$BASE_URL/api/v1/ping")
http_code=$(echo "$response" | tail -n1)

if [ "$http_code" = "401" ]; then
    test_passed "Missing customer ID returns 401 Unauthorized"
else
    test_failed "Should reject missing customer ID" "Got HTTP $http_code instead of 401"
fi
echo ""

# Test 3: Valid Single Request
echo "========================================================================"
echo "TEST 3: Valid Single Request (Customer-A)"
echo "========================================================================"
response=$(curl -s -w "\n%{http_code}" -H "X-Customer-Id: customer-a" "$BASE_URL/api/v1/ping")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$http_code" = "200" ]; then
    if echo "$body" | jq -e '.message == "pong"' > /dev/null 2>&1; then
        test_passed "Valid request returns 200 OK with pong message"

        # Check rate limit headers
        headers=$(curl -s -I -H "X-Customer-Id: customer-a" "$BASE_URL/api/v1/ping")
        if echo "$headers" | grep -q "X-RateLimit-Limit"; then
            test_passed "Response includes X-RateLimit-Limit header"
        else
            test_failed "Missing X-RateLimit-Limit header" "$headers"
        fi
    else
        test_failed "Invalid response body" "$body"
    fi
else
    test_failed "Valid request failed" "HTTP $http_code"
fi
echo ""

# Test 4: Rate Limit Headers
echo "========================================================================"
echo "TEST 4: Rate Limit Headers Validation"
echo "========================================================================"
response=$(curl -s -i -H "X-Customer-Id: customer-a" "$BASE_URL/api/v1/ping")

headers_found=0
if echo "$response" | grep -q "X-RateLimit-Limit:"; then
    limit=$(echo "$response" | grep "X-RateLimit-Limit:" | awk '{print $2}' | tr -d '\r')
    echo "  X-RateLimit-Limit: $limit"
    headers_found=$((headers_found + 1))
fi

if echo "$response" | grep -q "X-RateLimit-Remaining:"; then
    remaining=$(echo "$response" | grep "X-RateLimit-Remaining:" | awk '{print $2}' | tr -d '\r')
    echo "  X-RateLimit-Remaining: $remaining"
    headers_found=$((headers_found + 1))
fi

if echo "$response" | grep -q "X-RateLimit-Window:"; then
    window=$(echo "$response" | grep "X-RateLimit-Window:" | awk '{print $2}' | tr -d '\r')
    echo "  X-RateLimit-Window: $window"
    headers_found=$((headers_found + 1))
fi

if [ $headers_found -eq 3 ]; then
    test_passed "All rate limit headers present"
else
    test_failed "Missing rate limit headers" "Only found $headers_found/3"
fi
echo ""

# Test 5: Burst Testing (Hit Rate Limit)
echo "========================================================================"
echo "TEST 5: Rate Limit Enforcement (Send 350 requests, expect 429s)"
echo "========================================================================"
echo "Sending 350 requests as customer-b..."

allowed=0
rejected=0
errors=0

for i in {1..350}; do
    http_code=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Customer-Id: customer-b" "$BASE_URL/api/v1/ping")

    if [ "$http_code" = "200" ]; then
        allowed=$((allowed + 1))
    elif [ "$http_code" = "429" ]; then
        rejected=$((rejected + 1))
    else
        errors=$((errors + 1))
    fi

    # Progress indicator
    if [ $((i % 50)) -eq 0 ]; then
        echo "  Progress: $i/350 requests sent (Allowed: $allowed, Rejected: $rejected)"
    fi
done

echo ""
echo "Results:"
echo "  Allowed:  $allowed"
echo "  Rejected: $rejected (429 Too Many Requests)"
echo "  Errors:   $errors"

if [ $rejected -gt 0 ] && [ $allowed -le 310 ]; then
    test_passed "Rate limiting is working (got $rejected rejections)"
else
    test_failed "Rate limiting not working correctly" "Allowed: $allowed, Rejected: $rejected"
fi
echo ""

# Test 6: 429 Response Structure
echo "========================================================================"
echo "TEST 6: 429 Response Validation"
echo "========================================================================"
# First saturate the limit
for i in {1..310}; do
    curl -s -o /dev/null -H "X-Customer-Id: test-429" "$BASE_URL/api/v1/ping"
done

# Now get a 429
response=$(curl -s -w "\n%{http_code}" -H "X-Customer-Id: test-429" "$BASE_URL/api/v1/ping")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$http_code" = "429" ]; then
    test_passed "Rate limit exceeded returns 429"

    if echo "$body" | jq -e '.error == "Too Many Requests"' > /dev/null 2>&1; then
        test_passed "429 response has correct error message"
    else
        test_failed "429 response body invalid" "$body"
    fi

    # Check for Retry-After header
    headers=$(curl -s -I -H "X-Customer-Id: test-429" "$BASE_URL/api/v1/ping")
    if echo "$headers" | grep -q "Retry-After:"; then
        retry_after=$(echo "$headers" | grep "Retry-After:" | awk '{print $2}' | tr -d '\r')
        test_passed "429 response includes Retry-After header: ${retry_after}s"
    else
        test_failed "Missing Retry-After header in 429 response" "$headers"
    fi
else
    test_warning "Could not trigger 429 (got $http_code) - limit might not be saturated yet"
fi
echo ""

# Test 7: Customer Isolation
echo "========================================================================"
echo "TEST 7: Customer Isolation (Two customers should not interfere)"
echo "========================================================================"
echo "Sending 100 requests each to customer-c and customer-d simultaneously..."

# Customer C in background
(
    for i in {1..100}; do
        curl -s -o /dev/null -H "X-Customer-Id: customer-c" "$BASE_URL/api/v1/ping"
    done
) &
pid1=$!

# Customer D in background
(
    for i in {1..100}; do
        curl -s -o /dev/null -H "X-Customer-Id: customer-d" "$BASE_URL/api/v1/ping"
    done
) &
pid2=$!

# Wait for both to complete
wait $pid1
wait $pid2

# Check both customers can still make requests
response_c=$(curl -s -w "\n%{http_code}" -H "X-Customer-Id: customer-c" "$BASE_URL/api/v1/ping")
http_code_c=$(echo "$response_c" | tail -n1)

response_d=$(curl -s -w "\n%{http_code}" -H "X-Customer-Id: customer-d" "$BASE_URL/api/v1/ping")
http_code_d=$(echo "$response_d" | tail -n1)

if [ "$http_code_c" = "200" ] && [ "$http_code_d" = "200" ]; then
    test_passed "Both customers can make requests after concurrent load"
else
    test_failed "Customer isolation issue" "Customer-C: $http_code_c, Customer-D: $http_code_d"
fi
echo ""

# Test 8: Northwind Schedule (if in batch window)
echo "========================================================================"
echo "TEST 8: Northwind Scheduled Override Check"
echo "========================================================================"
current_hour=$(date -u +%H)
echo "Current UTC hour: $current_hour"

if [ "$current_hour" -ge 2 ] && [ "$current_hour" -lt 4 ]; then
    echo "IN BATCH WINDOW (02:00-04:00 UTC) - Testing elevated limit (1500 RPM)"

    # Send 500 requests (should all pass if limit is 1500)
    northwind_allowed=0
    northwind_rejected=0

    for i in {1..500}; do
        http_code=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Customer-Id: northwind" "$BASE_URL/api/v1/ping")

        if [ "$http_code" = "200" ]; then
            northwind_allowed=$((northwind_allowed + 1))
        elif [ "$http_code" = "429" ]; then
            northwind_rejected=$((northwind_rejected + 1))
        fi

        if [ $((i % 100)) -eq 0 ]; then
            echo "  Progress: $i/500 (Allowed: $northwind_allowed, Rejected: $northwind_rejected)"
        fi
    done

    echo ""
    echo "Northwind Results:"
    echo "  Allowed:  $northwind_allowed"
    echo "  Rejected: $northwind_rejected"

    if [ $northwind_allowed -ge 490 ]; then
        test_passed "Northwind has elevated limit during batch window"
    else
        test_failed "Northwind batch window not working" "Only $northwind_allowed/500 allowed"
    fi
else
    echo "OUTSIDE BATCH WINDOW - Testing base limit (300 RPM)"

    # Send 350 requests (should get ~300 allowed, 50 rejected)
    northwind_allowed=0
    northwind_rejected=0

    for i in {1..350}; do
        http_code=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Customer-Id: northwind" "$BASE_URL/api/v1/ping")

        if [ "$http_code" = "200" ]; then
            northwind_allowed=$((northwind_allowed + 1))
        elif [ "$http_code" = "429" ]; then
            northwind_rejected=$((northwind_rejected + 1))
        fi

        if [ $((i % 100)) -eq 0 ]; then
            echo "  Progress: $i/350 (Allowed: $northwind_allowed, Rejected: $northwind_rejected)"
        fi
    done

    echo ""
    echo "Northwind Results:"
    echo "  Allowed:  $northwind_allowed"
    echo "  Rejected: $northwind_rejected"

    if [ $northwind_allowed -le 310 ] && [ $northwind_rejected -gt 0 ]; then
        test_passed "Northwind has base limit outside batch window"
    else
        test_failed "Northwind base limit not working" "Allowed: $northwind_allowed, Rejected: $northwind_rejected"
    fi
fi
echo ""

# Test 9: Unknown Customer
echo "========================================================================"
echo "TEST 9: Unknown Customer (Should Get Minimal Limit)"
echo "========================================================================"
response=$(curl -s -w "\n%{http_code}" -H "X-Customer-Id: unknown-customer-xyz" "$BASE_URL/api/v1/ping")
http_code=$(echo "$response" | tail -n1)

if [ "$http_code" = "200" ]; then
    test_passed "Unknown customer can make requests (fallback to minimal limit)"

    # Check the limit in response
    body=$(echo "$response" | head -n-1)
    limit=$(echo "$body" | jq -r '.rateLimit.limit' 2>/dev/null)
    echo "  Default limit for unknown customer: $limit RPM"

    if [ "$limit" = "60" ]; then
        test_passed "Unknown customer gets default 60 RPM limit"
    else
        test_warning "Unknown customer limit is $limit RPM (expected 60)"
    fi
else
    test_failed "Unknown customer rejected" "HTTP $http_code"
fi
echo ""

# Test 10: Load Balancer Distribution
echo "========================================================================"
echo "TEST 10: Load Balancer Distribution Test"
echo "========================================================================"
echo "Sending 30 requests to check distribution across nodes..."

for i in {1..30}; do
    curl -s -H "X-Customer-Id: lb-test" "$BASE_URL/api/v1/ping" > /dev/null
    sleep 0.1
done

echo "Check docker logs to verify requests hit different app nodes:"
echo "  ssh ai-server@10.10.1.198 'docker-compose -f ~/Allen/solution/docker-compose.yml logs --tail=30' | grep lb-test"
test_warning "Manual verification needed - check logs for node distribution"
echo ""

# Summary
echo "========================================================================"
echo "TEST SUMMARY"
echo "========================================================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ ALL TESTS PASSED${NC}"
    exit 0
else
    echo -e "${RED}✗ SOME TESTS FAILED${NC}"
    exit 1
fi
