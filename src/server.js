const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const dispatcher = require('./dispatcher');
const mockReceiver = require('./mockReceiver');

const app = express();
app.use(express.json());

// Mount mock receiver endpoints
app.use('/mock', mockReceiver);

// Service Root & Info
app.get('/', (req, res) => {
  res.json({
    service: 'Webhook Delivery Service',
    version: '1.0.0',
    endpoints: {
      subscriptions: {
        create: 'POST /api/subscriptions',
        list: 'GET /api/subscriptions',
        get: 'GET /api/subscriptions/:id',
      },
      events: {
        ingest: 'POST /api/events',
        get: 'GET /api/events/:id',
        list: 'GET /api/events?status=pending|delivered|failed',
        manualRetry: 'POST /api/events/:id/retry',
      },
      mockEndpoints: {
        success: 'POST /mock/success',
        flaky: 'POST /mock/flaky',
        down: 'POST /mock/down',
        slow: 'POST /mock/slow',
      },
    },
  });
});

/**
 * -------------------------------------------------------------
 * SUBSCRIPTION ROUTES
 * -------------------------------------------------------------
 */

// Register a new customer subscription endpoint
app.post('/api/subscriptions', (req, res) => {
  const { customerId, url, secret } = req.body;

  if (!customerId || !url) {
    return res.status(400).json({ error: 'customerId and url are required.' });
  }

  // Validate URL format
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  const id = `sub_${crypto.randomUUID()}`;
  const signingSecret = secret || crypto.randomBytes(24).toString('hex');

  const subscription = db.createSubscription({
    id,
    customerId,
    url,
    secret: signingSecret,
  });

  return res.status(201).json(subscription);
});

// List all subscriptions and circuit breaker statuses
app.get('/api/subscriptions', (req, res) => {
  const subs = db.listSubscriptions();
  return res.json(subs);
});

// Get a single subscription
app.get('/api/subscriptions/:id', (req, res) => {
  const sub = db.getSubscription(req.params.id);
  if (!sub) {
    return res.status(404).json({ error: 'Subscription not found' });
  }
  return res.json(sub);
});

/**
 * -------------------------------------------------------------
 * EVENT INGESTION & QUERY ROUTES
 * -------------------------------------------------------------
 */

// Ingest an event from internal producer
app.post('/api/events', (req, res) => {
  const { subscriptionId, eventType, payload, customerId, maxAttempts } = req.body;

  if (!subscriptionId || !eventType || payload === undefined) {
    return res.status(400).json({
      error: 'subscriptionId, eventType, and payload are required.',
    });
  }

  const subscription = db.getSubscription(subscriptionId);
  if (!subscription) {
    return res.status(404).json({ error: `Subscription '${subscriptionId}' not found.` });
  }

  const eventId = `evt_${crypto.randomUUID()}`;
  const assignedCustomerId = customerId || subscription.customer_id;

  const event = db.createEvent({
    id: eventId,
    subscriptionId,
    customerId: assignedCustomerId,
    eventType,
    payload,
    maxAttempts: maxAttempts || config.defaultMaxAttempts,
  });

  // Prompt the dispatcher to process immediately
  dispatcher.triggerImmediate();

  return res.status(202).json({
    eventId: event.id,
    status: event.status,
    subscriptionId: event.subscription_id,
    eventType: event.event_type,
    createdAt: new Date(event.created_at).toISOString(),
    message: 'Event accepted for delivery',
  });
});

// Get event status, payload, and attempt history
app.get('/api/events/:id', (req, res) => {
  const event = db.getEvent(req.params.id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  const attempts = db.getAttemptsForEvent(event.id);

  return res.json({
    ...event,
    attempts,
  });
});

// List events with optional filters (?status=delivered, ?customerId=...)
app.get('/api/events', (req, res) => {
  const { status, customerId, limit, offset } = req.query;
  const events = db.listEvents({
    status: status || null,
    customerId: customerId || null,
    limit: limit ? parseInt(limit, 10) : 50,
    offset: offset ? parseInt(offset, 10) : 0,
  });

  return res.json({
    count: events.length,
    events,
  });
});

// Replay / Retry a Dead-Letter Queue event manually
app.post('/api/events/:id/retry', (req, res) => {
  const event = db.getEvent(req.params.id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  if (event.status !== 'failed') {
    return res.status(400).json({
      error: `Event is currently '${event.status}', only 'failed' events can be manually requeued.`,
    });
  }

  db.requeueEvent(event.id);
  dispatcher.triggerImmediate();

  return res.json({
    eventId: event.id,
    status: 'pending',
    message: 'Event requeued for delivery replay',
  });
});

module.exports = app;
