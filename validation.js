/** كل مدخلات العميل والأدمن تتحقق هنا؛ الأسعار والأدوار لا تؤخذ من العميل. */
import { z } from 'zod';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(400, result.error.issues[0]?.message || 'بيانات غير صحيحة.');
  return result.data;
}

export const email = z
  .email('البريد الإلكتروني غير صحيح.')
  .max(254)
  .transform((value) => value.toLowerCase());
export const password = z.string().min(12, 'كلمة المرور 12 حرفًا على الأقل.').max(128);
export const name = z.string().trim().min(3, 'الاسم ثلاثة أحرف على الأقل.').max(120);
export const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const hex = z
  .string()
  .regex(/^#[a-f0-9]{6}$/i, 'رمز اللون غير صحيح.')
  .transform((value) => value.toLowerCase());
export const portal = z.enum(['customer', 'admin']);
export const sizeCode = z.enum(['XS', 'S', 'M', 'L', 'XL', 'XXL']);
export const imagePath = z
  .string()
  .max(500)
  .refine(
    (value) =>
      (/^assets\/[a-zA-Z0-9_./-]+\.(png|jpg|jpeg|webp)$/i.test(value) && !value.includes('..')) ||
      /^https:\/\/[^\s<>"']+$/i.test(value),
    'استخدم مسار صورة محليًا أو رابط HTTPS.',
  );

export const productInput = z
  .object({
    sku: z.string().trim().min(2).max(50),
    name: z.string().trim().min(3).max(160),
    category: z.enum(['tee', 'hoodie']),
    description: z.string().trim().max(4000),
    tag: z.string().trim().max(60),
    fit: z.string().trim().max(100),
    price: z
      .number()
      .positive()
      .max(99999999.99)
      .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001),
    color: hex,
    active: z.boolean(),
    images: z
      .array(z.object({ path: imagePath, alt: z.string().max(200) }))
      .min(1)
      .max(10),
    sizes: z
      .array(z.object({ code: sizeCode, stock: z.number().int().min(0).max(1000000) }))
      .length(6)
      .refine(
        (items) => new Set(items.map((item) => item.code)).size === 6,
        'كل مقاس يظهر مرة واحدة.',
      ),
    version: z.number().int().positive().optional(),
  })
  .strict();

export const checkoutInput = z
  .object({
    checkoutKey: z.uuid(),
    items: z
      .array(
        z
          .object({
            productId: id,
            size: sizeCode,
            color: hex,
            quantity: z.number().int().min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    customer: z
      .object({
        name,
        phone: z.string().regex(/^(05\d{8}|\+9665\d{8})$/, 'رقم الجوال السعودي غير صحيح.'),
        city: z.string().trim().min(2).max(100),
        district: z.string().trim().min(2).max(100),
        street: z.string().trim().min(4).max(255),
        postal: z
          .string()
          .regex(/^\d{5}$/)
          .or(z.literal(''))
          .optional(),
        carrier: z.enum(['سبريد', 'سمسا', 'أرامكس']),
      })
      .strict(),
  })
  .strict();

export { z };
