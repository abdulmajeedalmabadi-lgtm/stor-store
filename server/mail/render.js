/** قوالب البريد منفصلة، وجميع القيم النصية تُهَرّب قبل إدخالها في HTML. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { rootPath } from '../config.js';
import { getOrder } from '../services/orders.js';

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

async function template(name, data, rawFields = []) {
  const source = await fs.readFile(path.join(rootPath, 'server', 'mail', 'templates', `${name}.html`), 'utf8');
  return source.replace(/{{(\w+)}}/g, (match, key) =>
    rawFields.includes(key) ? data[key] || '' : escapeHtml(data[key]),
  );
}

export async function renderInvoice(order) {
  const items = await Promise.all(
    order.items.map((item) =>
      template('invoice-item', {
        name: item.name,
        size: item.size,
        color: item.color,
        quantity: item.qty,
        price: item.price.toFixed(2),
        total: (item.price * item.qty).toFixed(2),
      }),
    ),
  );
  return template(
    'invoice',
    {
      invoiceNumber: order.invoiceNumber,
      orderNumber: order.number,
      date: new Date(order.date).toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' }),
      name: order.customer.name,
      email: order.customer.email,
      address: [order.customer.city, order.customer.district, order.customer.street].join('، '),
      items: items.join('\n'),
      subtotal: order.subtotal.toFixed(2),
      shipping: order.shipping.toFixed(2),
      total: order.total.toFixed(2),
    },
    ['items'],
  );
}

export async function renderMessage(job, payload) {
  if (job.template === 'password_reset')
    return {
      html: await template('password-reset', payload),
      text: `إعادة تعيين كلمة المرور خلال ${payload.minutes} دقيقة: ${payload.link}`,
    };
  if (job.template === 'order_status')
    return {
      html: await template('order-status', payload),
      text: `حالة الطلب ${payload.number}: ${payload.status}. ${payload.note || ''}`,
    };
  const order = await getOrder(payload.orderId);
  const html = await renderInvoice(order);
  return {
    html,
    text: `فاتورة ${order.invoiceNumber}، الإجمالي ${order.total} ر.س.`,
    attachments: [
      {
        filename: `${order.invoiceNumber}.html`,
        content: html,
        contentType: 'text/html; charset=utf-8',
      },
    ],
  };
}
