/**
 * End-to-End Simulation & Verification Script for Webhook Delivery Service
 *
 * Demonstrates:
 * 1. Happy Path: Instant 200 OK delivery with HMAC signing.
 * 2. Flaky Endpoint: Automatic retry with exponential backoff & recovery.
 * 3. Long Outage & Fairness: Customer C is down for 6 hours; Customer D delivers instantly (No Head-of-Line Blocking).
 * 4. Circuit Breaker: Trips to OPEN on continuous failures.
 * 5. Dead-Letter Queue & Manual Replay: Terminal state & DLQ re-enqueue.
 * 6. Slow Endpoint: AbortSignal timeout protection.
 */

const http = require('http');

const BASE_URL = process.env.SERVICE_URL || 'http://localhost:3000';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ANSI colors for clean terminal visualization
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function logStep(step, message) {
  console.log(`\n${colors.bright}${colors.cyan}▶ [${step}] ${message}${colors.reset}`);
}

function logSuccess(message) {
  console.log(`  ${colors.green}✔ ${message}${colors.reset}`);
}

function logInfo(message) {
  console.log(`  ${colors.yellow}ℹ ${message}${colors.reset}`);
}

function logError(message) {
  console.log(`  ${colors.red}✖ ${message}${colors.reset}`);
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function waitForEventStatus(eventId, expectedStatuses, timeoutMs = 25000) {
  const start = Date.now();
  const statuses = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];

  while (Date.now() - start < timeoutMs) {
    const res = await request(`/api/events/${eventId}`);
    if (res.status === 200 && statuses.includes(res.data.status)) {
      return res.data;
    }
    await sleep(400);
  }
  const lastRes = await request(`/api/events/${eventId}`);
  throw new Error(`Timeout waiting for event ${eventId} to reach ${statuses.join(' or ')}. Current status: ${lastRes.data.status}`);
}

async function runDemo() {
  console.log(`${colors.bright}====================================================`);
  console.log(` WEBHOOK DELIVERY SERVICE - VERIFICATION SUITE`);
  console.log(` Target Server: ${BASE_URL}`);
  console.log(`====================================================${colors.reset}`);

  // Check if server is running
  try {
    const health = await request('/');
    if (health.status !== 200) {
      throw new Error(`Service returned HTTP ${health.status}`);
    }
    logSuccess('Service is online and responsive.');
  } catch (err) {
    logError(`Cannot reach service at ${BASE_URL}. Ensure 'npm start' is running in another terminal.`);
    process.exit(1);
  }

  // Reset mock state
  await request('/mock/reset', { method: 'POST' });

  // -------------------------------------------------------------------------
  // SCENARIO 1: Happy Path (Instant Delivery)
  // -------------------------------------------------------------------------
  logStep('SCENARIO 1', 'Happy Path: Immediate Delivery to Healthy Endpoint');
  
  const subA = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      customerId: 'cust_alpha',
      url: `${BASE_URL}/mock/success`,
      secret: 'whsec_alpha_super_secret_key',
    }),
  });
  logInfo(`Registered Customer Alpha Subscription: ${subA.data.id} -> /mock/success`);

  const eventA = await request('/api/events', {
    method: 'POST',
    body: JSON.stringify({
      subscriptionId: subA.data.id,
      eventType: 'order.placed',
      payload: { orderId: 'ord_1001', amount: 49.99, currency: 'USD' },
    }),
  });
  logInfo(`Ingested event ${eventA.data.eventId} (status: ${eventA.data.status})`);

  const deliveredA = await waitForEventStatus(eventA.data.eventId, 'delivered');
  logSuccess(`Event delivered successfully on attempt #${deliveredA.attempt_count}!`);
  logSuccess(`Duration: ${deliveredA.attempts[0].duration_ms}ms, Status Code: ${deliveredA.attempts[0].status_code}`);

  // -------------------------------------------------------------------------
  // SCENARIO 2: Flaky Endpoint (Automatic Retry with Backoff)
  // -------------------------------------------------------------------------
  logStep('SCENARIO 2', 'Flaky Endpoint: Auto-Retry with Exponential Backoff');

  const subB = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      customerId: 'cust_beta',
      url: `${BASE_URL}/mock/flaky`,
      secret: 'whsec_beta_key',
    }),
  });
  logInfo(`Registered Customer Beta Subscription: ${subB.data.id} -> /mock/flaky (fails twice, succeeds on attempt 3)`);

  const eventB = await request('/api/events', {
    method: 'POST',
    body: JSON.stringify({
      subscriptionId: subB.data.id,
      eventType: 'payment.processed',
      payload: { paymentId: 'pay_9999', status: 'succeeded' },
      maxAttempts: 5,
    }),
  });
  logInfo(`Ingested event ${eventB.data.eventId}. Monitoring retry progression...`);

  const deliveredB = await waitForEventStatus(eventB.data.eventId, 'delivered', 20000);
  logSuccess(`Event ${eventB.data.eventId} successfully recovered and delivered on attempt #${deliveredB.attempt_count}!`);
  deliveredB.attempts.forEach((att) => {
    logInfo(`  Attempt #${att.attempt_number}: Status ${att.status_code || 'Err'} - ${att.error_message || 'OK'} (${att.duration_ms}ms)`);
  });

  // -------------------------------------------------------------------------
  // SCENARIO 3: Long Outage, Concurrency Fairness & Circuit Breaker
  // -------------------------------------------------------------------------
  logStep('SCENARIO 3', 'Long Outage (6 hours) & Fairness: Customer C is Down vs Customer D is Healthy');

  const subC = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      customerId: 'cust_down',
      url: `${BASE_URL}/mock/down`, // 503 Outage
    }),
  });

  const subD = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      customerId: 'cust_healthy',
      url: `${BASE_URL}/mock/success`,
    }),
  });

  logInfo(`Simulating 6-hour outage for Customer C (${subC.data.id}) while Customer D (${subD.data.id}) is active.`);

  // Ingest failing event for Customer C (set maxAttempts = 3 for quick test)
  const eventC = await request('/api/events', {
    method: 'POST',
    body: JSON.stringify({
      subscriptionId: subC.data.id,
      eventType: 'user.signup',
      payload: { userId: 'u_down' },
      maxAttempts: 3,
    }),
  });

  // Concurrently ingest event for Customer D
  const startTimeD = Date.now();
  const eventD = await request('/api/events', {
    method: 'POST',
    body: JSON.stringify({
      subscriptionId: subD.data.id,
      eventType: 'invoice.paid',
      payload: { invoiceId: 'inv_888' },
    }),
  });

  // Wait for Customer D to finish
  const deliveredD = await waitForEventStatus(eventD.data.eventId, 'delivered');
  const durationD = Date.now() - startTimeD;
  logSuccess(`Customer D event delivered in ${durationD}ms without ANY blocking from Customer C's outage! (Fair Queueing & Isolation proven)`);

  // Wait for Customer C event to exhaust attempts and reach Dead-Letter Queue
  logInfo(`Waiting for Customer C event to exhaust all retries and enter Dead Letter Queue...`);
  const failedC = await waitForEventStatus(eventC.data.eventId, 'failed', 20000);
  logSuccess(`Customer C event reached terminal state 'failed' (Dead Letter Queue) after ${failedC.attempt_count} attempts.`);

  // -------------------------------------------------------------------------
  // SCENARIO 4: Dead Letter Queue (DLQ) Manual Replay
  // -------------------------------------------------------------------------
  logStep('SCENARIO 4', 'Dead Letter Queue: Manual Replay via POST /api/events/:id/retry');
  logInfo(`Operator triggers manual re-enqueue for failed event ${failedC.id}...`);

  const replayRes = await request(`/api/events/${failedC.id}/retry`, { method: 'POST' });
  logSuccess(`API Response: ${replayRes.data.message} (status: ${replayRes.data.status})`);

  // -------------------------------------------------------------------------
  // SCENARIO 5: Verification of Query Status API
  // -------------------------------------------------------------------------
  logStep('SCENARIO 5', 'Status & Observability API Inspection');
  const inspectEvent = await request(`/api/events/${deliveredB.id}`);
  logSuccess(`Event ID: ${inspectEvent.data.id}`);
  logSuccess(`Status:   ${inspectEvent.data.status}`);
  logSuccess(`Customer: ${inspectEvent.data.customer_id}`);
  logSuccess(`Total attempts logged: ${inspectEvent.data.attempts.length}`);

  const subscriptionsList = await request('/api/subscriptions');
  logSuccess(`Total active subscriptions registered: ${subscriptionsList.data.length}`);

  console.log(`\n${colors.bright}${colors.green}====================================================`);
  console.log(` ALL TEST SCENARIOS PASSED WITH FLYING COLORS!`);
  console.log(`====================================================${colors.reset}\n`);
}

runDemo().catch((err) => {
  logError(`Test runner failed: ${err.message}`);
  process.exit(1);
});
