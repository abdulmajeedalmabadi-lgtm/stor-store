/** مسارات العميل: كل استعلام طلب أو عنوان مقيد بمعرف صاحب الجلسة. */
import { Router } from 'express';
import { requireSession, rateLimit } from '../middleware/access.js';
import { rows } from '../db.js';
import { z, parse, name, id, checkoutInput, HttpError } from '../validation.js';
import { createOrder, getOrder, listOrders } from '../services/orders.js';
import { renderInvoice } from '../mail/render.js';

export const customerRouter = Router();
customerRouter.use(requireSession('customer'));

customerRouter.get('/account', async (req, res) => {
  const [profile] = await rows('SELECT phone FROM customer_profiles WHERE user_id=?', [
    req.session.user.id,
  ]);
  res.json({ user: { ...req.session.user, phone: profile?.phone || '' } });
});
customerRouter.patch('/account', async (req, res) => {
  const input = parse(z.object({ name }).strict(), req.body);
  await rows('UPDATE users SET full_name=? WHERE id=?', [input.name, req.session.user.id]);
  res.json({ user: { ...req.session.user, name: input.name } });
});

customerRouter.get('/favorites', async (req, res) => {
  const favorites = await rows('SELECT product_id FROM favorites WHERE user_id=?', [
    req.session.user.id,
  ]);
  res.json({ favorites: favorites.map((item) => Number(item.product_id)) });
});
customerRouter.post('/favorites', async (req, res) => {
  const input = parse(z.object({ productId: id, favorite: z.boolean() }).strict(), req.body);
  const product = await rows('SELECT id FROM products WHERE id=?', [input.productId]);
  if (!product.length) throw new HttpError(404, 'المنتج غير موجود.');
  if (input.favorite)
    await rows('INSERT IGNORE INTO favorites (user_id,product_id) VALUES (?,?)', [
      req.session.user.id,
      input.productId,
    ]);
  else
    await rows('DELETE FROM favorites WHERE user_id=? AND product_id=?', [
      req.session.user.id,
      input.productId,
    ]);
  res.json({ message: 'حُفظت المفضلة.' });
});

customerRouter.get('/addresses', async (req, res) => {
  res.json({
    addresses: await rows('SELECT * FROM addresses WHERE user_id=? ORDER BY id DESC', [
      req.session.user.id,
    ]),
  });
});
customerRouter.post('/addresses', async (req, res) => {
  const input = parse(
    z
      .object({
        label: z.string().trim().min(1).max(50),
        city: z.string().trim().min(2).max(100),
        district: z.string().trim().min(2).max(100),
        street: z.string().trim().min(4).max(255),
        postal: z
          .string()
          .regex(/^\d{5}$/)
          .or(z.literal('')),
      })
      .strict(),
    req.body,
  );
  const inserted = await rows(
    `INSERT INTO addresses (user_id,label,city,district,street,postal_code)
    VALUES (?,?,?,?,?,?)`,
    [
      req.session.user.id,
      input.label,
      input.city,
      input.district,
      input.street,
      input.postal || null,
    ],
  );
  res.status(201).json({ id: inserted.insertId });
});
customerRouter.delete('/addresses/:id', async (req, res) => {
  const result = await rows('DELETE FROM addresses WHERE id=? AND user_id=?', [
    parse(id, req.params.id),
    req.session.user.id,
  ]);
  if (!result.affectedRows) throw new HttpError(404, 'العنوان غير موجود.');
  res.json({ message: 'حُذف العنوان.' });
});

customerRouter.get('/orders', async (req, res) =>
  res.json({ orders: await listOrders(req.session.user.id) }),
);
customerRouter.post('/orders', rateLimit('checkout', 30, 3600), async (req, res) => {
  const result = await createOrder(req.session.user, parse(checkoutInput, req.body));
  res.status(result.repeated ? 200 : 201).json(result);
});
customerRouter.get('/orders/:id', async (req, res) => {
  res.json({ order: await getOrder(parse(id, req.params.id), req.session.user.id) });
});
customerRouter.get('/orders/:id/invoice', async (req, res) => {
  const order = await getOrder(parse(id, req.params.id), req.session.user.id);
  res.type('html').send(await renderInvoice(order));
});
