/** محاولة رسالة واحدة كل دقيقة، مع بقاء الحجز وإعادة المحاولة في MySQL. */
import { sendNextMail } from '../../server/mail/worker.js';

export default async function () {
  await sendNextMail();
}
