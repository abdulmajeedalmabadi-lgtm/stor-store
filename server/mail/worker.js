/** عامل SMTP: حجز رسالة، إرسال حقيقي، ثم تحديث الحالة وإعادة المحاولة عند الفشل. */
import nodemailer from 'nodemailer';
import { pathToFileURL } from 'node:url';
import { pool, rows, transaction } from '../db.js';
import { config } from '../config.js';
import { decryptPayload } from '../security.js';
import { renderMessage } from './render.js';

let transport;
let timer;
let busy = false;

function getTransport() {
  if (!config.mail.host) return null;
  if (!transport)
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
      requireTLS: !config.mail.secure && !config.mail.allowInsecureLocal,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  return transport;
}

export async function sendNextMail() {
  const smtp = getTransport();
  if (!smtp) return { configured: false, sent: false };
  const job = await transaction(async (connection) => {
    const [candidate] = await rows(
      `SELECT * FROM email_outbox WHERE
      (status='queued' AND available_at<=UTC_TIMESTAMP(3)) OR
      (status='processing' AND locked_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 5 MINUTE))
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [],
      connection,
    );
    if (!candidate) return null;
    await rows(
      "UPDATE email_outbox SET status='processing',locked_at=UTC_TIMESTAMP(3),attempts=attempts+1 WHERE id=?",
      [candidate.id],
      connection,
    );
    return { ...candidate, attempts: candidate.attempts + 1 };
  });
  if (!job) return { configured: true, sent: false };
  try {
    const payload = decryptPayload(job.payload_encrypted);
    if (job.template === 'password_reset') {
      const valid = await rows(
        `SELECT id FROM password_reset_tokens WHERE id=? AND used_at IS NULL
        AND expires_at>UTC_TIMESTAMP(3)`,
        [payload.resetId],
      );
      if (!valid.length) {
        await rows(
          "UPDATE email_outbox SET status='cancelled',payload_encrypted=NULL,locked_at=NULL WHERE id=?",
          [job.id],
        );
        return { configured: true, sent: false, cancelled: true };
      }
    }
    const body = await renderMessage(job, payload);
    const result = await smtp.sendMail({
      from: config.mail.from,
      to: job.recipient,
      subject: job.subject,
      messageId: `<stor-mail-${job.id}@${new URL(config.origin).hostname}>`,
      ...body,
    });
    if (result.rejected?.length)
      throw Object.assign(new Error('Recipient rejected'), { code: 'RECIPIENT_REJECTED' });
    await rows(
      `UPDATE email_outbox SET status='sent',sent_at=UTC_TIMESTAMP(3),locked_at=NULL,
      last_error=NULL,payload_encrypted=NULL WHERE id=?`,
      [job.id],
    );
    return { configured: true, sent: true, id: Number(job.id) };
  } catch (error) {
    // لا نسجل محتوى الرسالة أو رابط الاستعادة أو بيانات SMTP.
    const failed = job.attempts >= 5;
    await rows(
      `UPDATE email_outbox SET status=?,locked_at=NULL,last_error=?,
      available_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND) WHERE id=?`,
      [
        failed ? 'failed' : 'queued',
        String(error.code || 'MAIL_DELIVERY_ERROR').slice(0, 100),
        Math.min(3600, 30 * 2 ** job.attempts),
        job.id,
      ],
    );
    return { configured: true, sent: false, failed };
  }
}

export function startMailWorker() {
  if (!config.mail.host || timer) return;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await sendNextMail();
    } catch (error) {
      console.error('Mail worker:', error.code || 'DATABASE_ERROR');
    } finally {
      busy = false;
    }
  }, 3000);
  timer.unref();
}

export function stopMailWorker() {
  clearInterval(timer);
  timer = null;
  transport?.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!config.mail.host)
    throw new Error('Configure SMTP_HOST in .env before starting the mail worker.');
  startMailWorker();
  // عامل مستقل يحتاج مرجعًا كي يبقى نشطًا.
  timer.ref();
  const close = async () => {
    stopMailWorker();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  console.log('SMTP outbox worker started.');
}
