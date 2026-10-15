import { config } from './config.js';
import { pool, rows } from './db.js';
import { createApp } from './app.js';
import { startMailWorker, stopMailWorker } from './mail/worker.js';

await rows('SELECT 1 AS connected');
const server = createApp().listen(config.port, '127.0.0.1', () => {
  console.log(`STOR: ${config.origin}`);
  console.log(`Admin: ${config.origin}/admin.html`);
  console.log(
    config.mail.host
      ? 'SMTP configured; messages use the persistent outbox.'
      : 'SMTP not configured; messages stay queued.',
  );
});
if (config.mail.workerEnabled) startMailWorker();

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  stopMailWorker();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
