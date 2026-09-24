const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Ensure database directory exists
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.dbPath);

// Enable WAL mode for high concurrency and foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    circuit_state TEXT NOT NULL DEFAULT 'CLOSED', -- 'CLOSED', 'OPEN', 'HALF_OPEN'
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    next_probe_at INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'delivered', 'failed'
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    next_retry_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    failed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS delivery_attempts (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    status_code INTEGER,
    response_body TEXT,
    error_message TEXT,
    duration_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_poller ON events(status, next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_events_subscription ON events(subscription_id);
  CREATE INDEX IF NOT EXISTS idx_events_customer ON events(customer_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_event ON delivery_attempts(event_id);
`);

// Prepared statements for high performance
const stmts = {
  // Subscription statements
  insertSubscription: db.prepare(`
    INSERT INTO subscriptions (id, customer_id, url, secret, circuit_state, consecutive_failures, next_probe_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'CLOSED', 0, 0, ?, ?)
  `),
  getSubscription: db.prepare(`SELECT * FROM subscriptions WHERE id = ?`),
  listSubscriptions: db.prepare(`SELECT * FROM subscriptions ORDER BY created_at DESC`),
  updateCircuit: db.prepare(`
    UPDATE subscriptions
    SET circuit_state = ?, consecutive_failures = ?, next_probe_at = ?, updated_at = ?
    WHERE id = ?
  `),

  // Event statements
  insertEvent: db.prepare(`
    INSERT INTO events (id, subscription_id, customer_id, event_type, payload, status, attempt_count, max_attempts, next_retry_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `),
  getEvent: db.prepare(`SELECT * FROM events WHERE id = ?`),
  listEvents: db.prepare(`
    SELECT * FROM events
    WHERE (? IS NULL OR status = ?)
      AND (? IS NULL OR customer_id = ?)
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `),
  getPendingEvents: db.prepare(`
    SELECT e.*, s.url as endpoint_url, s.secret as subscription_secret,
           s.circuit_state, s.consecutive_failures, s.next_probe_at
    FROM events e
    JOIN subscriptions s ON e.subscription_id = s.id
    WHERE e.status = 'pending' AND e.next_retry_at <= ?
    ORDER BY e.created_at ASC
    LIMIT ?
  `),
  markProcessing: db.prepare(`UPDATE events SET status = 'processing' WHERE id = ? AND status = 'pending'`),
  markDelivered: db.prepare(`
    UPDATE events
    SET status = 'delivered', attempt_count = attempt_count + 1, delivered_at = ?
    WHERE id = ?
  `),
  markRetry: db.prepare(`
    UPDATE events
    SET status = 'pending', attempt_count = attempt_count + 1, next_retry_at = ?
    WHERE id = ?
  `),
  markFailed: db.prepare(`
    UPDATE events
    SET status = 'failed', attempt_count = attempt_count + 1, failed_at = ?
    WHERE id = ?
  `),
  requeueEvent: db.prepare(`
    UPDATE events
    SET status = 'pending', attempt_count = 0, next_retry_at = ?, failed_at = NULL
    WHERE id = ?
  `),

  // Attempt statements
  insertAttempt: db.prepare(`
    INSERT INTO delivery_attempts (id, event_id, attempt_number, status_code, response_body, error_message, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getAttemptsForEvent: db.prepare(`
    SELECT * FROM delivery_attempts WHERE event_id = ? ORDER BY attempt_number ASC
  `),
};

// Reset any events left in 'processing' status on startup (e.g. from service crash/restart) back to 'pending'
const recoverUnfinishedEvents = () => {
  const info = db.prepare(`UPDATE events SET status = 'pending' WHERE status = 'processing'`).run();
  if (info.changes > 0) {
    console.log(`[DB] Recovered ${info.changes} event(s) from previous interrupted run back to 'pending'.`);
  }
};
recoverUnfinishedEvents();

module.exports = {
  db,
  
  // Subscription operations
  createSubscription({ id, customerId, url, secret }) {
    const now = Date.now();
    stmts.insertSubscription.run(id, customerId, url, secret, now, now);
    return this.getSubscription(id);
  },

  getSubscription(id) {
    return stmts.getSubscription.get(id);
  },

  listSubscriptions() {
    return stmts.listSubscriptions.all();
  },

  updateCircuit(id, { state, consecutiveFailures, nextProbeAt }) {
    const now = Date.now();
    stmts.updateCircuit.run(state, consecutiveFailures, nextProbeAt || 0, now, id);
  },

  // Event operations
  createEvent({ id, subscriptionId, customerId, eventType, payload, maxAttempts, delayMs = 0 }) {
    const now = Date.now();
    const nextRetryAt = now + delayMs;
    const serializedPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
    stmts.insertEvent.run(
      id,
      subscriptionId,
      customerId,
      eventType,
      serializedPayload,
      maxAttempts || config.defaultMaxAttempts,
      nextRetryAt,
      now
    );
    return this.getEvent(id);
  },

  getEvent(id) {
    const event = stmts.getEvent.get(id);
    if (!event) return null;
    return {
      ...event,
      payload: JSON.parse(event.payload),
    };
  },

  listEvents({ status = null, customerId = null, limit = 50, offset = 0 } = {}) {
    const rows = stmts.listEvents.all(status, status, customerId, customerId, limit, offset);
    return rows.map((r) => ({
      ...r,
      payload: JSON.parse(r.payload),
    }));
  },

  getPendingEvents(limit = 20, now = Date.now()) {
    const rows = stmts.getPendingEvents.all(now, limit);
    return rows.map((r) => ({
      ...r,
      payload: JSON.parse(r.payload),
    }));
  },

  markProcessing(id) {
    const res = stmts.markProcessing.run(id);
    return res.changes > 0;
  },

  markDelivered(id) {
    const now = Date.now();
    stmts.markDelivered.run(now, id);
  },

  markRetry(id, nextRetryAt) {
    stmts.markRetry.run(nextRetryAt, id);
  },

  markFailed(id) {
    const now = Date.now();
    stmts.markFailed.run(now, id);
  },

  requeueEvent(id) {
    const now = Date.now();
    const res = stmts.requeueEvent.run(now, id);
    return res.changes > 0;
  },

  // Attempt operations
  recordAttempt({ id, eventId, attemptNumber, statusCode, responseBody, errorMessage, durationMs }) {
    const now = Date.now();
    stmts.insertAttempt.run(
      id,
      eventId,
      attemptNumber,
      statusCode || null,
      responseBody ? responseBody.slice(0, 1000) : null, // truncate large responses
      errorMessage ? errorMessage.slice(0, 500) : null,
      durationMs,
      now
    );
  },

  getAttemptsForEvent(eventId) {
    return stmts.getAttemptsForEvent.all(eventId);
  },
};
