/** تجزئة كلمات المرور والرموز وتشفير طابور البريد. */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function constantEqual(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$131072$8$1$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$131072$8$1') return false;
  const result = await scrypt(password, parts[4], 64, SCRYPT_OPTIONS);
  return constantEqual(result.toString('hex'), parts[5]);
}

// القيم السرية داخل رسالة استعادة كلمة المرور لا تحفظ كنص واضح في MySQL.
export function encryptPayload(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
}

export function decryptPayload(value) {
  const [iv, tag, content] = value.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(config.encryptionKey, 'hex'),
    iv,
  );
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8'));
}
