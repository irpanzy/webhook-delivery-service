const path = require('path');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'webhooks.db'),
  
  // Dispatcher & Polling settings
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '500', 10),
  maxConcurrentDeliveries: parseInt(process.env.MAX_CONCURRENT_DELIVERIES || '10', 10),
  maxConcurrentPerSubscription: parseInt(process.env.MAX_CONCURRENT_PER_SUBSCRIPTION || '2', 10),

  // Delivery & Timeout settings
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '5000', 10),
  
  // Retry & Backoff settings
  defaultMaxAttempts: parseInt(process.env.DEFAULT_MAX_ATTEMPTS || '5', 10),
  initialRetryDelayMs: parseInt(process.env.INITIAL_RETRY_DELAY_MS || '2000', 10),
  maxRetryDelayMs: parseInt(process.env.MAX_RETRY_DELAY_MS || '60000', 10),
  backoffMultiplier: parseFloat(process.env.BACKOFF_MULTIPLIER || '2'),
  
  // Circuit Breaker settings for long outages
  circuitFailureThreshold: parseInt(process.env.CIRCUIT_FAILURE_THRESHOLD || '5', 10),
  circuitResetTimeoutMs: parseInt(process.env.CIRCUIT_RESET_TIMEOUT_MS || '30000', 10), // 30s probe window
};

module.exports = config;
