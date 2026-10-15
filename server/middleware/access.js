/** حماية المصدر والجلسة والصلاحيات وCSRF، وتحديد معدل محاولات الدخول. */
import { rows } from '../db.js';
import { config } from '../config.js';
import { constantEqual, digest } from '../security.js';
import { HttpError } from '../validation.js';

export function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('origin') !== config.origin) throw new HttpError(403, 'مصدر الطلب غير مسموح.');
  if (!req.is('application/json')) throw new HttpError(415, 'أرسل البيانات بصيغة JSON.');
  next();
}

function cookieToken(req, name) {
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  const token = cookie?.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}

export const cookieName = (portal) => `stor_${portal}`;
export const cookieOptions = (portal) => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: config.production,
  path: portal === 'admin' ? '/api/admin' : '/api',
});

export async function readSession(req, portal = 'customer') {
  const token = cookieToken(req, cookieName(portal));
  if (!token) return null;
  const result = await rows(
    `SELECT s.id AS session_id, s.csrf_token,
      u.id, u.full_name, u.email, u.username, r.code AS role
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN roles r ON r.id=u.role_id
    WHERE s.token_hash=? AND s.portal=? AND s.expires_at>UTC_TIMESTAMP(3)
      AND u.is_active=TRUE AND r.code=?`,
    [digest(token), portal, portal],
  );
  if (!result.length) return null;
  const session = result[0];
  return {
    id: session.session_id,
    csrf: session.csrf_token,
    user: {
      id: Number(session.id),
      name: session.full_name,
      email: session.email,
      username: session.username,
      role: session.role,
    },
  };
}

export function requireSession(portal = 'customer') {
  return async (req, res, next) => {
    const session = await readSession(req, portal);
    if (!session) throw new HttpError(401, 'سجّل الدخول للمتابعة.');
    req.session = session;
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      !constantEqual(req.get('x-csrf-token'), session.csrf)
    ) {
      throw new HttpError(403, 'انتهت صلاحية حماية الطلب. أعد تحميل الصفحة.');
    }
    next();
  };
}

export function rateLimit(group, maximum = 10, seconds = 900) {
  return async (req, res, next) => {
    const key = digest(`${config.encryptionKey}|${group}|${req.ip}`);
    await rows(
      `INSERT INTO rate_limits (bucket_hash,hits,expires_at)
      VALUES (?,1,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND))
      ON DUPLICATE KEY UPDATE hits=IF(expires_at<=UTC_TIMESTAMP(3),1,hits+1),
      expires_at=IF(expires_at<=UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND),expires_at)`,
      [key, seconds, seconds],
    );
    const [bucket] = await rows('SELECT hits FROM rate_limits WHERE bucket_hash=?', [key]);
    if (bucket.hits > maximum) {
      res.set('Retry-After', String(seconds));
      throw new HttpError(429, 'محاولات كثيرة. حاول لاحقًا.');
    }
    next();
  };
}

export function ipHash(req) {
  return digest(`${config.encryptionKey}|${req.ip}`);
}
