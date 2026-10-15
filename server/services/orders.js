/** الطلب والمخزون والفاتورة وطابور البريد تحفظ في معاملة واحدة. */
import { rows, transaction } from '../db.js';
import { HttpError } from '../validation.js';
import { queueMail } from '../mail/outbox.js';

export const SHIPPING_AMOUNT = 15;

export async function getOrder(orderId, customerId = null, connection) {
  const parameters = customerId === null ? [orderId] : [orderId, customerId];
  const [order] = await rows(
    `SELECT o.*,s.name_ar AS status_ar,i.invoice_number,a.full_name,a.email,
      a.phone,a.city,a.district,a.street,a.postal_code
    FROM orders o JOIN order_statuses s ON s.code=o.status_code
    JOIN order_addresses a ON a.order_id=o.id JOIN invoices i ON i.order_id=o.id
    WHERE o.id=? ${customerId === null ? '' : 'AND o.user_id=?'}`,
    parameters,
    connection,
  );
  if (!order) throw new HttpError(404, 'الطلب غير موجود.');
  const items = await rows(
    `SELECT oi.*,s.code AS size FROM order_items oi
    JOIN sizes s ON s.id=oi.size_id WHERE oi.order_id=? ORDER BY oi.id`,
    [order.id],
    connection,
  );
  const history = await rows(
    `SELECT h.status_code,s.name_ar AS status,h.note,h.created_at AS date
    FROM order_status_history h JOIN order_statuses s ON s.code=h.status_code
    WHERE h.order_id=? ORDER BY h.id`,
    [order.id],
    connection,
  );
  return {
    id: String(order.id),
    number: order.order_number,
    userId: Number(order.user_id),
    statusCode: order.status_code,
    status: order.status_ar,
    invoiceNumber: order.invoice_number,
    date: order.created_at,
    total: Number(order.total_amount),
    subtotal: Number(order.subtotal),
    shipping: Number(order.shipping_amount),
    customer: {
      name: order.full_name,
      email: order.email,
      phone: order.phone,
      city: order.city,
      district: order.district,
      street: order.street,
      postal: order.postal_code,
      shipper: order.carrier,
    },
    items: items.map((item) => ({
      id: Number(item.product_id),
      name: item.product_name,
      price: Number(item.unit_price),
      qty: item.quantity,
      color: item.color_hex,
      size: item.size,
    })),
    history,
  };
}

export async function listOrders(customerId = null) {
  const orders = await rows(
    `SELECT id FROM orders ${customerId === null ? '' : 'WHERE user_id=?'}
    ORDER BY id DESC LIMIT 100`,
    customerId === null ? [] : [customerId],
  );
  return Promise.all(orders.map((order) => getOrder(order.id, customerId)));
}

export async function createOrder(user, input) {
  const result = await transaction(async (connection) => {
    // هذا القفل يضمن أن إعادة الطلب المتزامنة بالمفتاح نفسه لا تخصم المخزون مرتين.
    await rows('SELECT id FROM users WHERE id=? FOR UPDATE', [user.id], connection);
    const [existing] = await rows(
      'SELECT id FROM orders WHERE user_id=? AND checkout_key=?',
      [user.id, input.checkoutKey],
      connection,
    );
    if (existing) return { id: existing.id, repeated: true };

    const items = new Map();
    for (const item of input.items) {
      const key = `${item.productId}|${item.size}|${item.color}`;
      const quantity = (items.get(key)?.quantity || 0) + item.quantity;
      if (quantity > 20) throw new HttpError(400, 'الحد الأعلى لكل منتج ولون ومقاس هو 20.');
      items.set(key, { ...item, quantity });
    }
    // ترتيب الأقفال ثابت لتقليل التعارض بين طلبين على منتجات متعددة.
    const ordered = [...items.values()].sort(
      (a, b) => a.productId - b.productId || a.size.localeCompare(b.size),
    );
    let subtotalCents = 0;
    const snapshots = [];
    for (const item of ordered) {
      const [product] = await rows(
        'SELECT * FROM products WHERE id=? AND is_active=TRUE FOR UPDATE',
        [item.productId],
        connection,
      );
      if (!product) throw new HttpError(409, 'أحد المنتجات لم يعد متاحًا. حدّث السلة.');
      const [size] = await rows(
        `SELECT ps.size_id,ps.stock_quantity FROM product_sizes ps
        JOIN sizes s ON s.id=ps.size_id WHERE ps.product_id=? AND s.code=? FOR UPDATE`,
        [item.productId, item.size],
        connection,
      );
      if (!size || size.stock_quantity < item.quantity)
        throw new HttpError(
          409,
          `المقاس ${item.size} من ${product.name} غير متوفر بالكمية المطلوبة.`,
        );
      await rows(
        'UPDATE product_sizes SET stock_quantity=stock_quantity-? WHERE product_id=? AND size_id=?',
        [item.quantity, item.productId, size.size_id],
        connection,
      );
      await rows('UPDATE products SET version=version+1 WHERE id=?', [item.productId], connection);
      const priceCents = Math.round(Number(product.price) * 100);
      subtotalCents += priceCents * item.quantity;
      snapshots.push({
        ...item,
        sizeId: size.size_id,
        name: product.name,
        price: priceCents / 100,
      });
    }

    const inserted = await rows(
      `INSERT INTO orders (user_id,checkout_key,subtotal,shipping_amount,carrier)
      VALUES (?,?,?,?,?)`,
      [user.id, input.checkoutKey, subtotalCents / 100, SHIPPING_AMOUNT, input.customer.carrier],
      connection,
    );
    const id = inserted.insertId;
    const number = `ST-${String(id).padStart(6, '0')}`;
    await rows('UPDATE orders SET order_number=? WHERE id=?', [number, id], connection);
    const customer = input.customer;
    // البريد يحدده الحساب الموثق، وليس بريدًا يرسله المتصفح.
    await rows(
      `INSERT INTO order_addresses (order_id,full_name,email,phone,city,district,street,postal_code)
      VALUES (?,?,?,?,?,?,?,?)`,
      [
        id,
        customer.name,
        user.email,
        customer.phone,
        customer.city,
        customer.district,
        customer.street,
        customer.postal || null,
      ],
      connection,
    );
    await rows(
      'UPDATE customer_profiles SET phone=? WHERE user_id=?',
      [customer.phone, user.id],
      connection,
    );
    for (const item of snapshots) {
      await rows(
        `INSERT INTO order_items (order_id,product_id,size_id,product_name,unit_price,quantity,color_hex)
        VALUES (?,?,?,?,?,?,?)`,
        [id, item.productId, item.sizeId, item.name, item.price, item.quantity, item.color],
        connection,
      );
    }
    await rows(
      `INSERT INTO order_status_history (order_id,status_code,changed_by,note)
      VALUES (?,'pending',?,'تم إنشاء الطلب')`,
      [id, user.id],
      connection,
    );
    await rows(
      'INSERT INTO invoices (order_id,invoice_number) VALUES (?,?)',
      [id, `INV-${new Date().getUTCFullYear()}-${String(id).padStart(6, '0')}`],
      connection,
    );
    await queueInvoice(connection, id, user.id, user.email, `invoice:auto:${id}`);
    return { id, repeated: false };
  });
  return { order: await getOrder(result.id, user.id), repeated: result.repeated };
}

export function queueInvoice(connection, orderId, userId, email, deduplicationKey) {
  return queueMail(connection, {
    userId,
    orderId,
    recipient: email,
    template: 'invoice',
    subject: 'STOR — فاتورة طلبك',
    payload: { orderId: String(orderId) },
    deduplicationKey,
  });
}

const TRANSITIONS = {
  pending: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
};

export async function changeOrderStatus(admin, orderId, input) {
  return transaction(async (connection) => {
    const [order] = await rows('SELECT * FROM orders WHERE id=? FOR UPDATE', [orderId], connection);
    if (!order) throw new HttpError(404, 'الطلب غير موجود.');
    if (order.status_code === input.status)
      return { message: 'الحالة لم تتغير؛ لم تُنشأ رسالة مكررة.' };
    if (!TRANSITIONS[order.status_code].includes(input.status))
      throw new HttpError(409, 'الانتقال إلى حالة الطلب المحددة غير مسموح.');
    if (input.status === 'cancelled') {
      const items = await rows(
        `SELECT product_id,size_id,SUM(quantity) AS quantity
        FROM order_items WHERE order_id=? GROUP BY product_id,size_id ORDER BY product_id,size_id`,
        [orderId],
        connection,
      );
      for (const item of items) {
        await rows('SELECT id FROM products WHERE id=? FOR UPDATE', [item.product_id], connection);
        await rows(
          'UPDATE product_sizes SET stock_quantity=stock_quantity+? WHERE product_id=? AND size_id=?',
          [Number(item.quantity), item.product_id, item.size_id],
          connection,
        );
        await rows(
          'UPDATE products SET version=version+1 WHERE id=?',
          [item.product_id],
          connection,
        );
      }
    }
    await rows('UPDATE orders SET status_code=? WHERE id=?', [input.status, orderId], connection);
    const history = await rows(
      `INSERT INTO order_status_history (order_id,status_code,changed_by,note)
      VALUES (?,?,?,?)`,
      [orderId, input.status, admin.id, input.note],
      connection,
    );
    await rows(
      `INSERT INTO admin_audit_log (admin_id,action,entity_type,entity_id,before_data,after_data)
      VALUES (?,'order_status','order',?,?,?)`,
      [
        admin.id,
        orderId,
        JSON.stringify({ status: order.status_code }),
        JSON.stringify({ status: input.status, note: input.note }),
      ],
      connection,
    );
    if (input.notify) {
      const [customer] = await rows(
        'SELECT full_name,email FROM order_addresses WHERE order_id=?',
        [orderId],
        connection,
      );
      const [status] = await rows(
        'SELECT name_ar FROM order_statuses WHERE code=?',
        [input.status],
        connection,
      );
      await queueMail(connection, {
        userId: order.user_id,
        orderId,
        recipient: customer.email,
        template: 'order_status',
        subject: `STOR — تحديث حالة الطلب ${order.order_number}`,
        payload: {
          name: customer.full_name,
          number: order.order_number,
          status: status.name_ar,
          note: input.note,
          link: `${(await import('../config.js')).config.origin}/#tracking/${orderId}`,
        },
        deduplicationKey: `status:${history.insertId}`,
      });
    }
    return {
      message: input.notify ? 'حُفظت الحالة وأُضيف الإشعار إلى طابور البريد.' : 'حُفظت حالة الطلب.',
    };
  });
}
