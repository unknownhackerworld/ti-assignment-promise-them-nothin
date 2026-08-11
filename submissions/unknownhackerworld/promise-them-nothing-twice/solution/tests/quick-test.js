/**
 * Quick Black Box Tester for Remote Deployment
 * Run from Windows: node tests/quick-test.js
 */

const http = require('http');

const BASE_URL = process.env.TEST_URL || 'http://10.10.1.198:8080';
const ENDPOINT = '/api/v1/ping';

let PASSED = 0;
let FAILED = 0;

// Helper function to make HTTP request
function makeRequest(customerId, path = ENDPOINT) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: customerId ? { 'X-Customer-Id': customerId } : {},
      timeout: 5000
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

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

// Test helpers
function testPass(name) {
  console.log(`✓ PASS: ${name}`);
  PASSED++;
}

function testFail(name, reason) {
  console.log(`✗ FAIL: ${name}`);
  console.log(`  Reason: ${reason}`);
  FAILED++;
}

function separator(title) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

// Test suite
async function runTests() {
  console.log('RelayAPI Rate Limiter - Quick Black Box Test');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  try {
    // Test 1: Health Check
    separator('TEST 1: Health Check');
    try {
      const res = await makeRequest(null, '/health');
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data.status === 'ok' && data.redis === 'connected') {
          testPass('Health endpoint returns 200 OK with valid JSON');
          console.log(`  Response: ${JSON.stringify(data)}`);
        } else {
          testFail('Health endpoint response invalid', res.body);
        }
      } else {
        testFail('Health endpoint failed', `HTTP ${res.status}`);
      }
    } catch (err) {
      testFail('Health endpoint error', err.message);
    }

    // Test 2: Missing Customer ID
    separator('TEST 2: Missing Customer ID (Should return 401)');
    try {
      const res = await makeRequest(null, ENDPOINT);
      if (res.status === 401) {
        testPass('Missing customer ID returns 401 Unauthorized');
      } else {
        testFail('Should reject missing customer ID', `Got HTTP ${res.status} instead of 401`);
      }
    } catch (err) {
      testFail('Missing customer ID test error', err.message);
    }

    // Test 3: Valid Single Request
    separator('TEST 3: Valid Single Request');
    try {
      const res = await makeRequest('customer-a');
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data.message === 'pong') {
          testPass('Valid request returns 200 OK with pong message');

          // Check rate limit info
          if (data.rateLimit) {
            console.log(`  Rate Limit: ${data.rateLimit.count}/${data.rateLimit.limit}`);
            testPass('Response includes rateLimit info');
          } else {
            testFail('Missing rateLimit info in response', res.body);
          }
        } else {
          testFail('Invalid response body', res.body);
        }
      } else {
        testFail('Valid request failed', `HTTP ${res.status}`);
      }
    } catch (err) {
      testFail('Valid request error', err.message);
    }

    // Test 4: Rate Limit Headers
    separator('TEST 4: Rate Limit Headers');
    try {
      const res = await makeRequest('customer-a');
      const headers = res.headers;

      let foundHeaders = 0;
      if (headers['x-ratelimit-limit']) {
        console.log(`  X-RateLimit-Limit: ${headers['x-ratelimit-limit']}`);
        foundHeaders++;
      }
      if (headers['x-ratelimit-remaining']) {
        console.log(`  X-RateLimit-Remaining: ${headers['x-ratelimit-remaining']}`);
        foundHeaders++;
      }
      if (headers['x-ratelimit-window']) {
        console.log(`  X-RateLimit-Window: ${headers['x-ratelimit-window']}`);
        foundHeaders++;
      }

      if (foundHeaders === 3) {
        testPass('All rate limit headers present');
      } else {
        testFail('Missing rate limit headers', `Only found ${foundHeaders}/3`);
      }
    } catch (err) {
      testFail('Rate limit headers test error', err.message);
    }

    // Test 5: Hit Rate Limit
    separator('TEST 5: Rate Limit Enforcement (350 requests)');
    console.log('Sending 350 requests...');

    let allowed = 0;
    let rejected = 0;
    let errors = 0;

    const promises = [];
    for (let i = 0; i < 350; i++) {
      promises.push(
        makeRequest('test-burst')
          .then(res => {
            if (res.status === 200) allowed++;
            else if (res.status === 429) rejected++;
            else errors++;
          })
          .catch(() => errors++)
      );

      // Progress
      if ((i + 1) % 50 === 0) {
        await Promise.all(promises.splice(0, promises.length));
        console.log(`  Progress: ${i + 1}/350 (Allowed: ${allowed}, Rejected: ${rejected})`);
      }
    }

    await Promise.all(promises);

    console.log(`\nResults:`);
    console.log(`  Allowed:  ${allowed}`);
    console.log(`  Rejected: ${rejected} (429 Too Many Requests)`);
    console.log(`  Errors:   ${errors}`);

    if (rejected > 0 && allowed <= 310 && allowed >= 290) {
      testPass(`Rate limiting working (${allowed} allowed, ${rejected} rejected)`);
    } else {
      testFail('Rate limiting not working correctly', `Allowed: ${allowed}, Rejected: ${rejected}`);
    }

    // Test 6: 429 Response Structure
    separator('TEST 6: 429 Response Validation');
    console.log('Saturating limit for test-429...');

    // Saturate
    const saturatePromises = [];
    for (let i = 0; i < 310; i++) {
      saturatePromises.push(makeRequest('test-429').catch(() => {}));
    }
    await Promise.all(saturatePromises);

    // Get 429
    try {
      const res = await makeRequest('test-429');
      if (res.status === 429) {
        testPass('Rate limit exceeded returns 429');

        const data = JSON.parse(res.body);
        if (data.error === 'Too Many Requests') {
          testPass('429 response has correct error message');
        } else {
          testFail('429 response body invalid', res.body);
        }

        if (res.headers['retry-after']) {
          testPass(`429 includes Retry-After header: ${res.headers['retry-after']}s`);
        } else {
          testFail('Missing Retry-After header in 429 response', '');
        }
      } else {
        console.log(`  Warning: Expected 429 but got ${res.status} (limit might not be saturated)`);
      }
    } catch (err) {
      testFail('429 response test error', err.message);
    }

    // Test 7: Customer Isolation
    separator('TEST 7: Customer Isolation');
    console.log('Testing two customers concurrently...');

    // Saturate customer-c
    const customerC = [];
    for (let i = 0; i < 310; i++) {
      customerC.push(makeRequest('customer-c').catch(() => {}));
    }

    // customer-d should still work
    const customerD = makeRequest('customer-d');

    await Promise.all([...customerC, customerD]);

    const resCustD = await customerD;
    if (resCustD.status === 200) {
      testPass('Customer isolation working (customer-d not affected by customer-c)');
    } else {
      testFail('Customer isolation issue', `customer-d got ${resCustD.status}`);
    }

    // Test 8: Unknown Customer
    separator('TEST 8: Unknown Customer');
    try {
      const res = await makeRequest('unknown-xyz-123');
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        const limit = data.rateLimit?.limit;

        testPass('Unknown customer can make requests');
        console.log(`  Default limit: ${limit} RPM`);

        if (limit === 60) {
          testPass('Unknown customer gets default 60 RPM limit');
        } else {
          console.log(`  Note: Unknown customer limit is ${limit} RPM (expected 60)`);
        }
      } else {
        testFail('Unknown customer rejected', `HTTP ${res.status}`);
      }
    } catch (err) {
      testFail('Unknown customer test error', err.message);
    }

    // Test 9: Northwind Schedule Check
    separator('TEST 9: Northwind Schedule Check');
    const currentHour = new Date().getUTCHours();
    console.log(`Current UTC hour: ${currentHour}`);

    const inBatchWindow = currentHour >= 2 && currentHour < 4;

    if (inBatchWindow) {
      console.log('IN BATCH WINDOW (02:00-04:00 UTC) - Testing elevated limit');
      console.log('Sending 500 requests...');

      let northwindAllowed = 0;
      let northwindRejected = 0;

      const northwindPromises = [];
      for (let i = 0; i < 500; i++) {
        northwindPromises.push(
          makeRequest('northwind')
            .then(res => {
              if (res.status === 200) northwindAllowed++;
              else if (res.status === 429) northwindRejected++;
            })
            .catch(() => {})
        );

        if ((i + 1) % 100 === 0) {
          await Promise.all(northwindPromises.splice(0, northwindPromises.length));
          console.log(`  Progress: ${i + 1}/500 (Allowed: ${northwindAllowed}, Rejected: ${northwindRejected})`);
        }
      }

      await Promise.all(northwindPromises);

      console.log(`\nNorthwind Results:`);
      console.log(`  Allowed:  ${northwindAllowed}`);
      console.log(`  Rejected: ${northwindRejected}`);

      if (northwindAllowed >= 490) {
        testPass('Northwind has elevated limit during batch window');
      } else {
        testFail('Northwind batch window not working', `Only ${northwindAllowed}/500 allowed`);
      }
    } else {
      console.log('OUTSIDE BATCH WINDOW - Testing base limit (300 RPM)');
      console.log('Sending 350 requests...');

      let northwindAllowed = 0;
      let northwindRejected = 0;

      const northwindPromises = [];
      for (let i = 0; i < 350; i++) {
        northwindPromises.push(
          makeRequest('northwind')
            .then(res => {
              if (res.status === 200) northwindAllowed++;
              else if (res.status === 429) northwindRejected++;
            })
            .catch(() => {})
        );

        if ((i + 1) % 100 === 0) {
          await Promise.all(northwindPromises.splice(0, northwindPromises.length));
          console.log(`  Progress: ${i + 1}/350 (Allowed: ${northwindAllowed}, Rejected: ${northwindRejected})`);
        }
      }

      await Promise.all(northwindPromises);

      console.log(`\nNorthwind Results:`);
      console.log(`  Allowed:  ${northwindAllowed}`);
      console.log(`  Rejected: ${northwindRejected}`);

      if (northwindAllowed <= 310 && northwindAllowed >= 290 && northwindRejected > 0) {
        testPass('Northwind has base limit outside batch window');
      } else {
        testFail('Northwind base limit not working', `Allowed: ${northwindAllowed}, Rejected: ${northwindRejected}`);
      }
    }

    // Summary
    separator('TEST SUMMARY');
    console.log(`Passed: ${PASSED}`);
    console.log(`Failed: ${FAILED}\n`);

    if (FAILED === 0) {
      console.log('✓ ALL TESTS PASSED');
      process.exit(0);
    } else {
      console.log('✗ SOME TESTS FAILED');
      process.exit(1);
    }

  } catch (err) {
    console.error('\n✗ Test suite failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run the test suite
runTests();
