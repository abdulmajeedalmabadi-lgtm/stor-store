/** تركيب المسارات والأمان وملفات الواجهة في أصل واحد؛ لا حاجة إلى CORS. */
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { config, rootPath } from './config.js';
import { rows } from './db.js';
import { sameOrigin, rateLimit } from './middleware/access.js';
import { authRouter, adminAuthRouter } from './routes/auth.js';
import { customerRouter } from './routes/customer.js';
import { adminRouter } from './routes/admin.js';
import { getProducts } from './services/catalog.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // لا نثق بـX-Forwarded-For تلقائيًا؛ إعداد reverse proxy يحتاج ضبطًا صريحًا.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.production ? [] : null,
        },
      },
      strictTransportSecurity: config.production ? undefined : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', sameOrigin, rateLimit('api', 1200, 300), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', async (req, res) => {
    await rows('SELECT 1 AS ok');
    res.json({ ok: true });
  });
  app.get('/api/products', async (req, res) => res.json({ products: await getProducts() }));
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminAuthRouter, adminRouter);
  app.use('/api', customerRouter);
  app.use('/api', (req, res) => res.status(404).json({ message: 'المسار غير موجود.' }));
  app.use(express.static(path.join(rootPath, 'dist'), { etag: true, maxAge: 0 }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.code === 'ER_DUP_ENTRY')
      return res
        .status(409)
        .json({ message: 'البريد أو اسم المستخدم أو رمز المنتج مستخدم بالفعل.' });
    if (error.type === 'entity.too.large')
      return res.status(413).json({ message: 'الطلب أكبر من الحجم المسموح.' });
    if (error instanceof SyntaxError && 'body' in error)
      return res.status(400).json({ message: 'صيغة JSON غير صحيحة.' });
    const status = Number(error.status) || 500;
    if (status >= 500) console.error('Server error:', error.code || error.name);
    return res
      .status(status)
      .json({ message: status >= 500 ? 'تعذر إكمال العملية. حاول لاحقًا.' : error.message });
  });
  return app;
}
