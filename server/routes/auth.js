import { Router } from 'express';
import { z, parse, name, email, password, portal } from '../validation.js';
import { readSession, requireSession, rateLimit } from '../middleware/access.js';
import { register, login, logout, requestPasswordReset, resetPassword } from '../services/auth.js';

export const authRouter = Router();
export const adminAuthRouter = Router();

const loginInput = z
  .object({ identifier: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) })
  .strict();

authRouter.get('/session', async (req, res) => {
  const session = await readSession(req, 'customer');
  res.json(session ? { user: session.user, csrf: session.csrf } : { user: null, csrf: null });
});
authRouter.post('/register', rateLimit('register', 8), async (req, res) => {
  const input = parse(z.object({ name, email, password }).strict(), req.body);
  res.status(201).json(await register(req, res, input));
});
authRouter.post('/login', rateLimit('customer-login', 10), async (req, res) => {
  res.json(await login(req, res, parse(loginInput, req.body), 'customer'));
});
authRouter.post('/logout', requireSession(), async (req, res) => {
  await logout(req, res, 'customer');
  res.json({ message: 'تم تسجيل الخروج، وبيانات الحساب محفوظة.' });
});
authRouter.post('/forgot-password', rateLimit('forgot-password', 5), async (req, res) => {
  res.json(await requestPasswordReset(parse(z.object({ email, portal }).strict(), req.body)));
});
authRouter.post('/reset-password', rateLimit('reset-password', 10), async (req, res) => {
  res.json(
    await resetPassword(
      req,
      parse(
        z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), portal, password }).strict(),
        req.body,
      ),
    ),
  );
});

adminAuthRouter.get('/session', async (req, res) => {
  const session = await readSession(req, 'admin');
  res.json(session ? { user: session.user, csrf: session.csrf } : { user: null, csrf: null });
});
adminAuthRouter.post('/login', rateLimit('admin-login', 8), async (req, res) => {
  res.json(await login(req, res, parse(loginInput, req.body), 'admin'));
});
adminAuthRouter.post('/logout', requireSession('admin'), async (req, res) => {
  await logout(req, res, 'admin');
  res.json({ message: 'تم تسجيل خروج الأدمن.' });
});
