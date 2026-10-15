/** لوحة الأدمن: إدارة فعلية، وسجل تدقيق، دون كشف كلمات المرور أو رموز الاستعادة. */
import { Router } from 'express';
import { requireSession, rateLimit } from '../middleware/access.js';
import { rows, transaction } from '../db.js';
import { config } from '../config.js';
import { z, parse, id, productInput, HttpError } from '../validation.js';
import { getProducts } from '../services/catalog.js';
import { listOrders, getOrder, changeOrderStatus, queueInvoice } from '../services/orders.js';
import { renderInvoice } from '../mail/render.js';

export const adminRouter = Router();
adminRouter.use(requireSession('admin'));

adminRouter.get('/dashboard', async (req, res) => {
  const [counts] = await rows(`SELECT
    (SELECT COUNT(*) FROM products WHERE is_active=TRUE) AS products,
    (SELECT COUNT(*) FROM users WHERE role_id=1) AS customers,
    (SELECT COUNT(*) FROM orders) AS orders,
    (SELECT COUNT(*) FROM orders WHERE status_code='pending') AS pending,
    (SELECT COALESCE(SUM(total_amount),0) FROM orders WHERE status_code='delivered') AS deliveredRevenue`);
  res.json({ counts, smtpConfigured: Boolean(config.mail.host) });
});
adminRouter.get('/customers', async (req, res) => {
  res.json({ customers: await rows('SELECT * FROM v_customers ORDER BY id DESC LIMIT 200') });
});
adminRouter.get('/products', async (req, res) =>
  res.json({ products: await getProducts({ includeInactive: true }) }),
);

async function saveProduct(admin, input, productId = null) {
  return transaction(async (connection) => {
    let before = null;
    let finalId = productId;
    const [category] = await rows(
      'SELECT id FROM categories WHERE code=?',
      [input.category],
      connection,
    );
    if (productId !== null) {
      const [locked] = await rows(
        'SELECT * FROM products WHERE id=? FOR UPDATE',
        [productId],
        connection,
      );
      if (!locked) throw new HttpError(404, 'المنتج غير موجود.');
      if (locked.version !== input.version)
        throw new HttpError(409, 'تغيّر المنتج أو مخزونه منذ فتحه. حدّث البيانات ثم عدّل من جديد.');
      [before] = (await getProducts({ includeInactive: true }, connection)).filter(
        (product) => product.id === productId,
      );
      await rows(
        `UPDATE products SET category_id=?,sku=?,name=?,description=?,tag=?,fit=?,price=?,
        default_color=?,is_active=?,version=version+1 WHERE id=?`,
        [
          category.id,
          input.sku,
          input.name,
          input.description,
          input.tag,
          input.fit,
          input.price,
          input.color,
          input.active,
          productId,
        ],
        connection,
      );
      await rows('DELETE FROM product_images WHERE product_id=?', [productId], connection);
    } else {
      const inserted = await rows(
        `INSERT INTO products (category_id,sku,name,description,tag,fit,price,default_color,is_active)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          category.id,
          input.sku,
          input.name,
          input.description,
          input.tag,
          input.fit,
          input.price,
          input.color,
          input.active,
        ],
        connection,
      );
      finalId = inserted.insertId;
    }
    for (let index = 0; index < input.images.length; index += 1) {
      const image = input.images[index];
      await rows(
        'INSERT INTO product_images (product_id,image_path,alt_text,sort_order) VALUES (?,?,?,?)',
        [finalId, image.path, image.alt, index],
        connection,
      );
    }
    for (const size of input.sizes) {
      const [reference] = await rows('SELECT id FROM sizes WHERE code=?', [size.code], connection);
      await rows(
        `INSERT INTO product_sizes (product_id,size_id,stock_quantity) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE stock_quantity=VALUES(stock_quantity)`,
        [finalId, reference.id, size.stock],
        connection,
      );
    }
    await rows(
      `INSERT INTO admin_audit_log (admin_id,action,entity_type,entity_id,before_data,after_data)
      VALUES (?,?,'product',?,?,?)`,
      [
        admin.id,
        productId ? 'product_update' : 'product_create',
        finalId,
        before ? JSON.stringify(before) : null,
        JSON.stringify(input),
      ],
      connection,
    );
    return Number(finalId);
  });
}

adminRouter.post('/products', async (req, res) => {
  const productId = await saveProduct(req.session.user, parse(productInput, req.body));
  res
    .status(201)
    .json({ id: productId, message: 'أُضيف المنتج وسيظهر في موقع العميل إذا كان نشطًا.' });
});
adminRouter.put('/products/:id', async (req, res) => {
  const input = parse(productInput.extend({ version: z.number().int().positive() }), req.body);
  await saveProduct(req.session.user, input, parse(id, req.params.id));
  res.json({ message: 'حُفظ المنتج في قاعدة البيانات.' });
});

adminRouter.get('/orders', async (req, res) => res.json({ orders: await listOrders() }));
adminRouter.get('/orders/:id', async (req, res) =>
  res.json({ order: await getOrder(parse(id, req.params.id)) }),
);
adminRouter.patch('/orders/:id/status', async (req, res) => {
  const input = parse(
    z
      .object({
        status: z.enum(['pending', 'shipped', 'out_for_delivery', 'delivered', 'cancelled']),
        note: z.string().trim().max(500),
        notify: z.boolean(),
      })
      .strict(),
    req.body,
  );
  res.json(await changeOrderStatus(req.session.user, parse(id, req.params.id), input));
});
adminRouter.post(
  '/orders/:id/send-invoice',
  rateLimit('send-invoice', 30, 3600),
  async (req, res) => {
    const input = parse(z.object({ requestId: z.uuid() }).strict(), req.body);
    const orderId = parse(id, req.params.id);
    const order = await getOrder(orderId);
    const mailId = await transaction(async (connection) => {
      const result = await queueInvoice(
        connection,
        orderId,
        order.userId,
        order.customer.email,
        `invoice:manual:${orderId}:${input.requestId}`,
      );
      await rows(
        `INSERT INTO admin_audit_log (admin_id,action,entity_type,entity_id,after_data)
      VALUES (?,'send_invoice','order',?,?)`,
        [req.session.user.id, orderId, JSON.stringify({ mailId: result })],
        connection,
      );
      return result;
    });
    res
      .status(202)
      .json({ mailId, message: 'أُضيفت الفاتورة لطابور البريد. راجع حالة الإرسال في سجل البريد.' });
  },
);
adminRouter.get('/orders/:id/invoice', async (req, res) => {
  res.type('html').send(await renderInvoice(await getOrder(parse(id, req.params.id))));
});

adminRouter.get('/mail', async (req, res) => {
  const messages = await rows(`SELECT id,order_id,template,recipient,subject,status,attempts,
    created_at,sent_at,last_error FROM email_outbox ORDER BY id DESC LIMIT 100`);
  res.json({ messages, smtpConfigured: Boolean(config.mail.host) });
});
adminRouter.post('/mail/:id/retry', rateLimit('mail-retry', 30, 3600), async (req, res) => {
  const mailId = parse(id, req.params.id);
  const result = await rows(
    `UPDATE email_outbox SET status='queued',attempts=0,available_at=UTC_TIMESTAMP(3),last_error=NULL
    WHERE id=? AND status='failed' AND payload_encrypted IS NOT NULL`,
    [mailId],
  );
  if (!result.affectedRows) throw new HttpError(409, 'يمكن إعادة محاولة الرسائل الفاشلة فقط.');
  res.json({ message: 'أُعيدت الرسالة إلى الطابور.' });
});
adminRouter.get('/audit', async (req, res) => {
  res.json({
    events:
      await rows(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.before_data,a.after_data,a.created_at,
    u.full_name AS admin_name FROM admin_audit_log a JOIN users u ON u.id=a.admin_id ORDER BY a.id DESC LIMIT 100`),
  });
});
