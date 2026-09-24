const express = require('express');
const { verifySignature } = require('./signature');

const router = express.Router();

// Memory store to track flaky attempts per event ID
const flakyAttempts = new Map();

/**
 * Endpoint 1: Healthy endpoint
 * Returns 200 OK immediately.
 */
router.post('/success', (req, res) => {
  const eventId = req.headers['x-event-id'];
  const signature = req.headers['x-webhook-signature'];
  const attempt = req.headers['x-delivery-attempt'];

  return res.status(200).json({
    status: 'ok',
    message: 'Event processed successfully',
    eventId,
    attempt,
    receivedAt: new Date().toISOString(),
  });
});

/**
 * Endpoint 2: Flaky endpoint
 * Fails the first 2 attempts with 500, then succeeds on attempt #3.
 */
router.post('/flaky', (req, res) => {
  const eventId = req.headers['x-event-id'] || 'unknown';
  const currentCount = (flakyAttempts.get(eventId) || 0) + 1;
  flakyAttempts.set(eventId, currentCount);

  if (currentCount <= 2) {
    return res.status(500).json({
      status: 'error',
      message: `Temporary server failure (simulated error, attempt ${currentCount}/2)`,
      eventId,
    });
  }

  // Succeeded on 3rd attempt!
  return res.status(200).json({
    status: 'ok',
    message: `Recovered and processed successfully on attempt ${currentCount}`,
    eventId,
  });
});

/**
 * Endpoint 3: Down endpoint
 * Simulates a long outage (returns 503 Service Unavailable every time).
 */
router.post('/down', (req, res) => {
  const eventId = req.headers['x-event-id'];
  return res.status(503).json({
    status: 'error',
    message: 'Customer service is down for maintenance (simulated 6-hour outage)',
    eventId,
  });
});

/**
 * Endpoint 4: Slow endpoint
 * Deliberately delays for 6000ms, triggering the service's 5000ms AbortSignal timeout.
 */
router.post('/slow', async (req, res) => {
  const eventId = req.headers['x-event-id'];
  // Wait 6 seconds
  await new Promise((resolve) => setTimeout(resolve, 6000));
  return res.status(200).json({
    status: 'ok',
    message: 'Slow response completed',
    eventId,
  });
});

/**
 * Reset mock memory state
 */
router.post('/reset', (req, res) => {
  flakyAttempts.clear();
  return res.json({ status: 'ok', message: 'Mock state reset' });
});

module.exports = router;
