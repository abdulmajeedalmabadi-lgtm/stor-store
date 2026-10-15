/** محول Netlify: لا نشغّل listen أو مؤقت البريد داخل الدالة. */
import serverless from 'serverless-http';
import { createApp } from '../../server/app.js';

export const handler = serverless(createApp(), {
  request(req, event) {
    // هذه القيمة تأتي من بوابة Netlify؛ لا نثق بسلسلة X-Forwarded-For العامة.
    const clientIp = event.headers?.['x-nf-client-connection-ip'];
    if (clientIp) Object.defineProperty(req, 'ip', { value: clientIp, configurable: true });
  },
});
