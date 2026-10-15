/** كتابة الرسالة داخل معاملة العملية الأصلية؛ لا تضيع بعد إعادة تشغيل الخادم. */
import { rows } from '../db.js';
import { encryptPayload } from '../security.js';

export async function queueMail(connection, message) {
  const result = await rows(
    `INSERT INTO email_outbox
    (user_id,order_id,template,recipient,subject,payload_encrypted,deduplication_key)
    VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
    [
      message.userId,
      message.orderId || null,
      message.template,
      message.recipient,
      message.subject,
      encryptPayload(message.payload),
      message.deduplicationKey || null,
    ],
    connection,
  );
  return Number(result.insertId);
}
