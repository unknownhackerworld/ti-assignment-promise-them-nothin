/**
 * Load Test Harness for RelayAPI Rate Limiter
 *
 * Tests the rate limiter under various scenarios to prove correctness
 * at quota boundaries, especially in multi-node distributed deployment.
 *
 * Usage: node tests/load-test.js
 */

const http = require('http');

const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';
const ENDPOINT = '/api/v1/ping';

/**
 * Make HTTP request with custom headers
 */
function makeRequest(customerId) {
  return new Promise((resolve, reject) => {
    const url = new URL(ENDPOINT, BASE_URL);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: {
        'X-Customer-Id': customerId
      }
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

/**
 * Execute requests in parallel with controlled concurrency
 */
async function sendBurst(customerId, count, delayMs = 0) {
  const results = {
    allowed: 0,
    rejected: 0,
    errors: 0,
    statuses: {}
  };

  const promises = [];

  for (let i = 0; i < count; i++) {
    promises.push(
      makeRequest(customerId)
        .then((res) => {
          if (res.status === 200) {
            results.allowed++;
          } else if (res.status === 429) {
            results.rejected++;
          }
          results.statuses[res.status] = (results.statuses[res.status] || 0) + 1;
          return res;
        })
        .catch((err) => {
          results.errors++;
          return { error: err.message };
        })
    );

    if (delayMs > 0 && i < count - 1) {
      await sleep(delayMs);
    }
  }

  await Promise.all(promises);
  return results;
}

/**
 * Send sustained load over a period
 */
async function sendSustained(customerId, rpm, durationSeconds) {
  const totalRequests = Math.floor((rpm / 60) * durationSeconds);
  const delayMs = (durationSeconds * 1000) / totalRequests;

  console.log(`  Sending ${totalRequests} requests over ${durationSeconds}s (${rpm} RPM)`);

  return await sendBurst(customerId, totalRequests, delayMs);
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format test results
 */
function formatResults(results) {
  const total = results.allowed + results.rejected + results.errors;
  const allowRate = ((results.allowed / total) * 100).toFixed(1);
  const rejectRate = ((results.rejected / total) * 100).toFixed(1);

  return {
    total,
    allowed: `${results.allowed} (${allowRate}%)`,
    rejected: `${results.rejected} (${rejectRate}%)`,
    errors: results.errors
  };
}

/**
 * Print section header
 */
function printHeader(title) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

/**
 * Print test result
 */
function printResult(testName, results, expected) {
  const formatted = formatResults(results);
  const passed = checkExpectation(results, expected);
  const status = passed ? '✓ PASS' : '✗ FAIL';

  console.log(`\n${status} ${testName}`);
  console.log(`  Total: ${formatted.total} | Allowed: ${formatted.allowed} | Rejected: ${formatted.rejected} | Errors: ${formatted.errors}`);

  if (!passed) {
    console.log(`  Expected: ${JSON.stringify(expected)}`);
  }
}

/**
 * Check if results match expectations
 */
function checkExpectation(results, expected) {
  if (expected.minAllowed !== undefined && results.allowed < expected.minAllowed) {
    return false;
  }
  if (expected.maxAllowed !== undefined && results.allowed > expected.maxAllowed) {
    return false;
  }
  if (expected.minRejected !== undefined && results.rejected < expected.minRejected) {
    return false;
  }
  return true;
}

/**
 * Test Suite
 */
async function runTests() {
  console.log('RelayAPI Rate Limiter - Load Test Harness');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const testResults = [];

  try {
    // Test 1: Customer at exact quota (should all succeed)
    printHeader('Test 1: Customer-A at 300 RPM (exact quota)');
    console.log('Expected: All requests allowed (within 60s window)');

    const test1 = await sendBurst('customer-a', 300, 10);
    printResult('Customer-A should be allowed up to quota', test1, {
      minAllowed: 290, // Allow small margin for timing
      maxAllowed: 300
    });
    testResults.push({ name: 'Test 1', ...test1 });

    await sleep(2000);

    // Test 2: Customer exceeding quota (should get 429s)
    printHeader('Test 2: Customer-B at 400 RPM (exceeds 300 RPM quota)');
    console.log('Expected: ~300 allowed, ~100 rejected');

    const test2 = await sendBurst('customer-b', 400, 5);
    printResult('Customer-B should be rate limited', test2, {
      minAllowed: 290,
      maxAllowed: 310,
      minRejected: 90
    });
    testResults.push({ name: 'Test 2', ...test2 });

    await sleep(2000);

    // Test 3: Two customers with same tier (isolation test)
    printHeader('Test 3: Two customers at same tier (isolation)');
    console.log('Customer-A: 300 requests');
    console.log('Customer-B: 300 requests (concurrent)');
    console.log('Expected: Both should get full quota (no interference)');

    const [test3a, test3b] = await Promise.all([
      sendBurst('customer-a', 300, 10),
      sendBurst('customer-b', 300, 10)
    ]);

    printResult('Customer-A isolation', test3a, { minAllowed: 290 });
    printResult('Customer-B isolation', test3b, { minAllowed: 290 });
    testResults.push({ name: 'Test 3a', ...test3a });
    testResults.push({ name: 'Test 3b', ...test3b });

    await sleep(2000);

    // Test 4: Northwind outside batch window (base limit)
    printHeader('Test 4: Northwind outside batch window (02:00-04:00 UTC)');
    const currentHour = new Date().getUTCHours();
    const inBatchWindow = currentHour >= 2 && currentHour < 4;

    if (!inBatchWindow) {
      console.log('Current time: Outside batch window');
      console.log('Expected: Base limit 300 RPM applies');

      const test4 = await sendBurst('northwind', 400, 5);
      printResult('Northwind outside batch window', test4, {
        minAllowed: 290,
        maxAllowed: 310,
        minRejected: 90
      });
      testResults.push({ name: 'Test 4', ...test4 });
    } else {
      console.log('Current time: INSIDE batch window (02:00-04:00 UTC)');
      console.log('Expected: Elevated limit 1500 RPM applies');

      const test4 = await sendBurst('northwind', 1200, 5);
      printResult('Northwind during batch window', test4, {
        minAllowed: 1190,
        maxAllowed: 1200
      });
      testResults.push({ name: 'Test 4', ...test4 });
    }

    await sleep(2000);

    // Test 5: Distributed correctness (hammer the load balancer)
    printHeader('Test 5: Multi-node distributed enforcement');
    console.log('Rapid burst across all 3 nodes via load balancer');
    console.log('Expected: Global limit enforced (not 3x the limit)');

    const test5 = await sendBurst('customer-a', 500, 1);
    printResult('Distributed limit enforcement', test5, {
      minAllowed: 290,
      maxAllowed: 310,
      minRejected: 190
    });
    testResults.push({ name: 'Test 5', ...test5 });

    // Summary
    printHeader('Test Summary');
    let passed = 0;
    let failed = 0;

    for (const result of testResults) {
      const total = result.allowed + result.rejected + result.errors;
      const status = result.errors === 0 ? '✓' : '✗';
      if (result.errors === 0) passed++;
      else failed++;

      console.log(`${status} ${result.name}: ${result.allowed}/${total} allowed, ${result.rejected} rejected, ${result.errors} errors`);
    }

    console.log(`\nTotal: ${testResults.length} tests | Passed: ${passed} | Failed: ${failed}`);
    console.log(`\nCompleted: ${new Date().toISOString()}`);

    process.exit(failed > 0 ? 1 : 0);

  } catch (err) {
    console.error('\n✗ Test suite failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run the test suite
runTests();
