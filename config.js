/** قراءة الإعدادات والتحقق منها؛ لا توجد كلمات مرور داخل المصدر. */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootPath = process.env.LAMBDA_TASK_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: process.env.ENV_FILE || path.join(rootPath, '.env'), quiet: true });

function integer(name, fallback, min = 1, max = 65535) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export const config = {
  production: process.env.NODE_ENV === 'production',
  port: integer('PORT', 3000),
  origin: new URL(process.env.APP_ORIGIN || 'http://localhost:3000').origin,
  sessionDays: integer('SESSION_DAYS', 7, 1, 30),
  resetMinutes: integer('RESET_MINUTES', 30, 5, 60),
  encryptionKey: process.env.MAIL_ENCRYPTION_KEY || '',
  database: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: integer('DB_PORT', 3306),
    database: process.env.DB_NAME || 'stor',
    user: process.env.DB_USER || 'stor_app',
    password: process.env.DB_PASSWORD || '',
    connectionLimit: integer('DB_POOL_SIZE', 10, 1, 50),
    charset: 'utf8mb4',
    timezone: 'Z',
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    // شهادة المزود بصيغة PEM عند استعمال جهة إصدار خاصة؛ لا نعطّل التحقق.
    ...(process.env.DB_SSL === 'true' ? {
      ssl: { rejectUnauthorized: true, ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n') } : {}) },
    } : {}),
  },
  mail: {
    host: process.env.SMTP_HOST || '',
    port: integer('SMTP_PORT', 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'STOR <store@example.com>',
    allowInsecureLocal: process.env.SMTP_ALLOW_INSECURE_LOCAL === 'true',
    workerEnabled: process.env.MAIL_WORKER_ENABLED !== 'false',
  },
};

if (!/^[a-f0-9]{64}$/i.test(config.encryptionKey)) {
  throw new Error('Run npm run config:init to generate MAIL_ENCRYPTION_KEY, then configure .env.');
}
if (config.production && !config.origin.startsWith('https://')) {
  throw new Error('Production APP_ORIGIN must use HTTPS.');
}
if (
  config.mail.allowInsecureLocal &&
  !['127.0.0.1', 'localhost', '::1'].includes(config.mail.host)
) {
  throw new Error('Insecure SMTP is allowed only for a local test server.');
}
