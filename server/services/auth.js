/** دورة حياة الحساب؛ الخروج يلغي الجلسة وحدها ولا يحذف المستخدم. */
import { rows, transaction } from '../db.js';
import { config } from '../config.js';
import { randomToken, digest, hashPassword, verifyPassword } from '../security.js';
import { cookieName, cookieOptions, ipHash } from '../middleware/access.js';
import { HttpError } from '../validation.js';
import { queueMail } from '../mail/outbox.js';
import { setTimeout as delay } from 'node:timers/promises';

const dummyHash = hashPassword('unusable-dummy-account-password');

async function authEvent(connection, req, userId, event, succeeded) {
  await rows(
    `INSERT INTO auth_events (user_id,event_type,succeeded,ip_hash) VALUES (?,?,?,?)`,
    [userId, event, succeeded, ipHash(req)],
    connection,
  );
}

async function createSession(connection, userId, portal) {
  const token = randomToken();
  const csrf = randomToken();
  await rows(
    `INSERT INTO sessions (user_id,portal,token_hash,csrf_token,expires_at)
    VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? DAY))`,
    [userId, portal, digest(token), csrf, config.sessionDays],
    connection,
  );
  return { token, csrf };
}

function setCookie(res, portal, token) {
  res.cookie(cookieName(portal), token, {
    ...cookieOptions(portal),
    maxAge: config.sessionDays * 86400000,
  });
}

export async function register(req, res, input) {
  const hashed = await hashPassword(input.password);
  const result = await transaction(async (connection) => {
    const inserted = await rows(
      `INSERT INTO users (role_id,full_name,email,password_hash)
      VALUES (1,?,?,?)`,
      [input.name, input.email, hashed],
      connection,
    );
    const userId = inserted.insertId;
    await rows('INSERT INTO customer_profiles (user_id) VALUES (?)', [userId], connection);
    await authEvent(connection, req, userId, 'register', true);
    const session = await createSession(connection, userId, 'customer');
    return {
      user: { id: Number(userId), name: input.name, email: input.email, role: 'customer' },
      ...session,
    };
  });
  setCookie(res, 'customer', result.token);
  return { user: result.user, csrf: result.csrf };
}

export async function login(req, res, input, portal) {
  const [user] = await rows(
    `SELECT u.*,r.code AS role FROM users u JOIN roles r ON r.id=u.role_id
    WHERE (u.email=? OR u.username=?) AND r.code=? LIMIT 1`,
    [input.identifier.toLowerCase(), input.identifier.toLowerCase(), portal],
  );
  const valid = await verifyPassword(input.password, user?.password_hash || (await dummyHash));
  if (!user || !user.is_active || !valid) {
    await authEvent(undefined, req, user?.id || null, `${portal}_login`, false);
    throw new HttpError(401, 'بيانات الدخول غير صحيحة.');
  }
  const result = await transaction(async (connection) => {
    // قفل المستخدم يمنع إنشاء جلسة بكلمة مرور قديمة بالتزامن مع إعادة التعيين.
    const [locked] = await rows(
      'SELECT password_hash,is_active FROM users WHERE id=? FOR UPDATE',
      [user.id],
      connection,
    );
    if (!locked.is_active || locked.password_hash !== user.password_hash)
      throw new HttpError(401, 'أعد تسجيل الدخول.');
    await rows('UPDATE users SET last_login_at=UTC_TIMESTAMP(3) WHERE id=?', [user.id], connection);
    await authEvent(connection, req, user.id, `${portal}_login`, true);
    return createSession(connection, user.id, portal);
  });
  setCookie(res, portal, result.token);
  return {
    user: {
      id: Number(user.id),
      name: user.full_name,
      email: user.email,
      username: user.username,
      role: portal,
    },
    csrf: result.csrf,
  };
}

export async function logout(req, res, portal) {
  await rows('DELETE FROM sessions WHERE id=?', [req.session.id]);
  res.clearCookie(cookieName(portal), cookieOptions(portal));
}

export async function requestPasswordReset(input) {
  const started = performance.now();
  await transaction(async (connection) => {
    const [user] = await rows(
      `SELECT u.id,u.full_name,u.email FROM users u JOIN roles r ON r.id=u.role_id
      WHERE u.email=? AND r.code=? AND u.is_active=TRUE FOR UPDATE`,
      [input.email, input.portal],
      connection,
    );
    if (!user) return;
    const token = randomToken();
    await rows(
      'UPDATE password_reset_tokens SET used_at=UTC_TIMESTAMP(3) WHERE user_id=? AND used_at IS NULL',
      [user.id],
      connection,
    );
    const inserted = await rows(
      `INSERT INTO password_reset_tokens (user_id,portal,token_hash,expires_at)
      VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? MINUTE))`,
      [user.id, input.portal, digest(token), config.resetMinutes],
      connection,
    );
    const link = `${config.origin}/#reset-password/${token}/${input.portal}`;
    await queueMail(connection, {
      userId: user.id,
      template: 'password_reset',
      recipient: user.email,
      subject: 'STOR — إعادة تعيين كلمة المرور',
      payload: {
        name: user.full_name,
        link,
        minutes: config.resetMinutes,
        resetId: inserted.insertId,
      },
      deduplicationKey: `reset:${inserted.insertId}`,
    });
  });
  // النتيجة وحدها الزمني الأدنى متطابقان للحساب الموجود وغير الموجود.
  await delay(Math.max(0, 300 - (performance.now() - started)));
  // لا يعاد رمز الاستعادة في API أو في سجل الخادم.
  return { message: 'إذا كان البريد مسجلًا فستصلك رسالة لإعادة تعيين كلمة المرور.' };
}

export async function resetPassword(req, input) {
  const [candidate] = await rows(
    `SELECT id,user_id FROM password_reset_tokens
    WHERE token_hash=? AND portal=? AND used_at IS NULL AND expires_at>UTC_TIMESTAMP(3)`,
    [digest(input.token), input.portal],
  );
  if (!candidate) throw new HttpError(400, 'رابط إعادة التعيين غير صالح أو منتهي.');
  const hashed = await hashPassword(input.password);
  await transaction(async (connection) => {
    await rows('SELECT id FROM users WHERE id=? FOR UPDATE', [candidate.user_id], connection);
    const [token] = await rows(
      `SELECT id FROM password_reset_tokens WHERE id=? AND used_at IS NULL
      AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE`,
      [candidate.id],
      connection,
    );
    if (!token) throw new HttpError(400, 'رابط إعادة التعيين غير صالح أو منتهي.');
    await rows(
      'UPDATE users SET password_hash=?,password_changed_at=UTC_TIMESTAMP(3) WHERE id=?',
      [hashed, candidate.user_id],
      connection,
    );
    await rows(
      'UPDATE password_reset_tokens SET used_at=UTC_TIMESTAMP(3) WHERE user_id=? AND used_at IS NULL',
      [candidate.user_id],
      connection,
    );
    await rows('DELETE FROM sessions WHERE user_id=?', [candidate.user_id], connection);
    await authEvent(connection, req, candidate.user_id, 'password_reset', true);
  });
  return { message: 'تم تغيير كلمة المرور. سجّل الدخول بكلمة المرور الجديدة.' };
}
