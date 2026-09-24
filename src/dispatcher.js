const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { signPayload } = require('./signature');

class Dispatcher {
  constructor() {
    this.isRunning = false;
    this.pollTimer = null;
    this.activePerSubscription = new Map(); // subscriptionId -> active count
    this.activeTotal = 0;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[Dispatcher] Service started. Listening for pending webhook deliveries...');
    this.scheduleNextPoll(100);
  }

  stop() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[Dispatcher] Service stopped.');
  }

  scheduleNextPoll(delayMs = config.pollIntervalMs) {
    if (!this.isRunning) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll(), delayMs);
  }

  // Wake up immediately when a new event arrives
  triggerImmediate() {
    if (!this.isRunning) return;
    if (this.activeTotal < config.maxConcurrentDeliveries) {
      setImmediate(() => this.poll());
    }
  }

  /**
   * Main dispatcher poll loop:
   * 1. Pulls ready events (status = 'pending' AND next_retry_at <= now)
   * 2. Enforces per-subscription and global concurrency limits (fairness)
   * 3. Checks circuit breaker state for long outages
   */
  async poll() {
    if (!this.isRunning) return;

    try {
      const availableCapacity = config.maxConcurrentDeliveries - this.activeTotal;
      if (availableCapacity <= 0) {
        this.scheduleNextPoll();
        return;
      }

      const pendingEvents = db.getPendingEvents(availableCapacity * 2, Date.now());

      for (const event of pendingEvents) {
        if (this.activeTotal >= config.maxConcurrentDeliveries) break;

        const subId = event.subscription_id;
        const currentActiveForSub = this.activePerSubscription.get(subId) || 0;

        // Fairness check: Prevent a single subscription from starving others
        if (currentActiveForSub >= config.maxConcurrentPerSubscription) {
          continue;
        }

        // Circuit Breaker check: Handle long outages gracefully
        const now = Date.now();
        if (event.circuit_state === 'OPEN') {
          if (now < event.next_probe_at) {
            // Circuit is still open; postpone this event to probe time without hammering endpoint
            db.markRetry(event.id, event.next_probe_at);
            continue;
          } else {
            // Half-open: Allow 1 test probe delivery
            console.log(`[CircuitBreaker] Subscription ${subId} moving to HALF_OPEN probe...`);
            db.updateCircuit(subId, {
              state: 'HALF_OPEN',
              consecutiveFailures: event.consecutive_failures,
              nextProbeAt: 0,
            });
          }
        }

        // Atomically claim the event for processing
        const claimed = db.markProcessing(event.id);
        if (!claimed) continue;

        // Increment concurrency counters
        this.activeTotal++;
        this.activePerSubscription.set(subId, currentActiveForSub + 1);

        // Execute delivery asynchronously (non-blocking)
        this.executeDelivery(event)
          .catch((err) => {
            console.error(`[Dispatcher] Unexpected error processing event ${event.id}:`, err);
          })
          .finally(() => {
            this.activeTotal--;
            const count = this.activePerSubscription.get(subId) || 1;
            if (count <= 1) {
              this.activePerSubscription.delete(subId);
            } else {
              this.activePerSubscription.set(subId, count - 1);
            }
            // Trigger next check to keep pipeline full
            this.triggerImmediate();
          });
      }
    } catch (err) {
      console.error('[Dispatcher] Error in poll loop:', err);
    } finally {
      this.scheduleNextPoll();
    }
  }

  /**
   * Performs the HTTP POST request to the destination URL
   */
  async executeDelivery(event) {
    const attemptNumber = event.attempt_count + 1;
    const startTime = Date.now();
    const attemptId = `att_${crypto.randomUUID()}`;

    // Generate HMAC signature & timestamp
    const signatureInfo = signPayload(event.payload, event.subscription_secret);

    let statusCode = null;
    let responseBody = null;
    let errorMessage = null;
    let isSuccess = false;

    try {
      const response = await fetch(event.endpoint_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Webhook-Delivery-Service/1.0',
          'X-Event-ID': event.id, // For Customer Idempotency
          'X-Event-Type': event.event_type,
          'X-Customer-ID': event.customer_id,
          'X-Delivery-Attempt': String(attemptNumber),
          'X-Webhook-Signature': signatureInfo.headerValue,
          'X-Webhook-Timestamp': String(signatureInfo.timestamp),
        },
        body: JSON.stringify(event.payload),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });

      statusCode = response.status;
      const text = await response.text();
      responseBody = text;

      // HTTP 2xx indicates successful delivery
      if (response.ok) {
        isSuccess = true;
      } else {
        errorMessage = `HTTP error ${response.status} ${response.statusText}`;
      }
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        errorMessage = `Request timed out after ${config.requestTimeoutMs}ms`;
      } else {
        errorMessage = `Network error: ${err.message}`;
      }
    }

    const durationMs = Date.now() - startTime;

    // Record the attempt log
    db.recordAttempt({
      id: attemptId,
      eventId: event.id,
      attemptNumber,
      statusCode,
      responseBody,
      errorMessage,
      durationMs,
    });

    if (isSuccess) {
      this.handleSuccess(event, attemptNumber, statusCode, durationMs);
    } else {
      this.handleFailure(event, attemptNumber, errorMessage, durationMs);
    }
  }

  handleSuccess(event, attemptNumber, statusCode, durationMs) {
    console.log(`[Dispatcher] Event ${event.id} DELIVERED on attempt #${attemptNumber} (HTTP ${statusCode}, ${durationMs}ms)`);
    db.markDelivered(event.id);

    // Reset circuit breaker for subscription
    const sub = db.getSubscription(event.subscription_id);
    if (sub && (sub.circuit_state !== 'CLOSED' || sub.consecutive_failures > 0)) {
      console.log(`[CircuitBreaker] Subscription ${event.subscription_id} recovered. Circuit state -> CLOSED`);
      db.updateCircuit(event.subscription_id, {
        state: 'CLOSED',
        consecutiveFailures: 0,
        nextProbeAt: 0,
      });
    }
  }

  handleFailure(event, attemptNumber, errorMessage, durationMs) {
    console.warn(`[Dispatcher] Event ${event.id} FAILED attempt #${attemptNumber}: ${errorMessage} (${durationMs}ms)`);

    const subId = event.subscription_id;
    const sub = db.getSubscription(subId);
    const newConsecutiveFailures = (sub ? sub.consecutive_failures : 0) + 1;

    // Check if circuit should trip OPEN due to repeated failures
    if (newConsecutiveFailures >= config.circuitFailureThreshold) {
      const probeAt = Date.now() + config.circuitResetTimeoutMs;
      console.warn(`[CircuitBreaker] Subscription ${subId} exceeded failure threshold (${newConsecutiveFailures}). Circuit state -> OPEN until ${new Date(probeAt).toISOString()}`);
      db.updateCircuit(subId, {
        state: 'OPEN',
        consecutiveFailures: newConsecutiveFailures,
        nextProbeAt: probeAt,
      });
    } else if (sub) {
      db.updateCircuit(subId, {
        state: sub.circuit_state,
        consecutiveFailures: newConsecutiveFailures,
        nextProbeAt: sub.next_probe_at,
      });
    }

    // Check if we still have retry attempts remaining
    if (attemptNumber < event.max_attempts) {
      const nextDelayMs = this.calculateBackoff(attemptNumber);
      const nextRetryAt = Date.now() + nextDelayMs;
      console.log(`[Dispatcher] Scheduling retry #${attemptNumber + 1} for event ${event.id} in ${(nextDelayMs / 1000).toFixed(1)}s`);
      db.markRetry(event.id, nextRetryAt);
    } else {
      // Terminal state: Dead Letter Queue
      console.error(`[Dispatcher] Event ${event.id} reached max attempts (${event.max_attempts}). Status -> FAILED (Dead Letter Queue)`);
      db.markFailed(event.id);
    }
  }

  /**
   * Exponential backoff with Full Jitter:
   * delay = min(maxDelay, initialDelay * (multiplier ^ (attempt - 1)))
   * with random jitter between 75% and 125% of delay to prevent thundering herds.
   */
  calculateBackoff(attempt) {
    const rawDelay = Math.min(
      config.maxRetryDelayMs,
      config.initialRetryDelayMs * Math.pow(config.backoffMultiplier, attempt - 1)
    );
    // Add ±25% random jitter
    const jitter = (Math.random() * 0.5 + 0.75);
    return Math.floor(rawDelay * jitter);
  }
}

module.exports = new Dispatcher();
