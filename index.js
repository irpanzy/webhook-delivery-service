const app = require('./src/server');
const config = require('./src/config');
const dispatcher = require('./src/dispatcher');
const { db } = require('./src/db');

const server = app.listen(config.port, () => {
  console.log(`====================================================`);
  console.log(` Webhook Delivery Service running on port ${config.port}`);
  console.log(` Database: ${config.dbPath}`);
  console.log(` Ingestion API: POST http://localhost:${config.port}/api/events`);
  console.log(` Status API:    GET  http://localhost:${config.port}/api/events/:id`);
  console.log(`====================================================`);
  
  // Start background delivery dispatcher engine
  dispatcher.start();
});

// Graceful shutdown handling
function shutdown(signal) {
  console.log(`\nReceived ${signal}. Gracefully shutting down...`);
  dispatcher.stop();

  server.close(() => {
    console.log('HTTP server closed.');
    try {
      db.close();
      console.log('Database connection closed.');
    } catch (e) {
      // ignore
    }
    process.exit(0);
  });

  // Force exit if shutdown hangs
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
