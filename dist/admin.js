/** لوحة الإدارة: HTML في القوالب، CSS مستقل، والعمليات كلها عبر API محمي. */
const state = {
  user: null,
  csrf: null,
  view: 'dashboard',
  products: [],
  orders: [],
  editingProduct: null,
  editingOrder: null,
};
const select = (selector, root = document) => root.querySelector(selector);
const money = (amount) => `${Number(amount).toLocaleString('ar-SA')} ر.س`;
const date = (value) => new Date(value).toLocaleString('ar-SA');
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const STATUS_LABELS = {
  pending: 'قيد التجهيز',
  shipped: 'تم الشحن',
  out_for_delivery: 'جاري التوصيل',
  delivered: 'تم التسليم',
  cancelled: 'ملغي',
};
const TRANSITIONS = {
  pending: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
};

/** طلب إداري؛ الجلسة HttpOnly وCSRF مطلوبان لكل عملية تغيير. */
async function request(path, method = 'GET', body) {
  const response = await fetch(`/api/admin${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') showLogin();
    throw new Error(result.message || 'تعذرت العملية.');
  }
  return result;
}

function clone(name) {
  return document.getElementById(`admin-${name}-template`).content.cloneNode(true);
}

function cell(fragment, name, value) {
  select(`[data-cell="${name}"]`, fragment).textContent = value ?? '—';
}

function message(text) {
  select('#admin-message').textContent = text;
  select('#admin-message').hidden = !text;
}

function showError(error) {
  select('#admin-error').textContent = error.message || 'تعذر الاتصال بالخادم.';
}

function showLogin() {
  state.user = null;
  state.csrf = null;
  state.products = [];
  state.orders = [];
  select('#admin-content').replaceChildren();
  select('#admin-shell').hidden = true;
  select('#admin-login').hidden = false;
}

/** جلب قسم كامل من MySQL ثم تعبئة قالب عرضه. */
async function loadView(view = state.view) {
  state.view = view;
  select('#admin-error').textContent = '';
  document.querySelectorAll('[data-view]').forEach((button) => {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const content = select('#admin-content');
  content.replaceChildren();
  content.append(clone(view));
  if (view === 'dashboard') {
    const result = await request('/dashboard');
    for (const element of document.querySelectorAll('[data-metric]'))
      element.textContent = result.counts[element.dataset.metric];
    select('#admin-revenue').textContent = money(result.counts.deliveredRevenue);
    select('#smtp-summary').textContent = result.smtpConfigured
      ? 'إعدادات SMTP موجودة. راجع سجل البريد لمعرفة نجاح الإرسال أو فشله.'
      : 'SMTP غير مضبوط. تبقى الفواتير والرسائل محفوظة في الطابور إلى أن تضبط إعدادات البريد.';
  }
  if (view === 'products') {
    state.products = (await request('/products')).products;
    for (const product of state.products) {
      const fragment = clone('product-row');
      cell(fragment, 'name', product.name);
      cell(fragment, 'sku', product.sku);
      cell(fragment, 'price', money(product.price));
      cell(
        fragment,
        'stock',
        product.sizes.reduce((sum, size) => sum + size.stock, 0),
      );
      cell(fragment, 'active', product.active ? 'ظاهر للعميل' : 'معطل');
      select('[data-action="edit-product"]', fragment).dataset.id = product.id;
      select('#admin-products-body').append(fragment);
    }
  }
  if (view === 'orders') {
    state.orders = (await request('/orders')).orders;
    for (const order of state.orders) {
      const fragment = clone('order-row');
      cell(fragment, 'number', order.number);
      cell(fragment, 'customer', `${order.customer.name} — ${order.customer.email}`);
      cell(fragment, 'total', money(order.total));
      cell(fragment, 'status', order.status);
      select('[data-action="edit-order"]', fragment).dataset.id = order.id;
      select('[data-action="send-invoice"]', fragment).dataset.id = order.id;
      select('[data-action="invoice-link"]', fragment).href =
        `/api/admin/orders/${order.id}/invoice`;
      select('#admin-orders-body').append(fragment);
    }
  }
  if (view === 'customers') {
    for (const customer of (await request('/customers')).customers) {
      const fragment = clone('customer-row');
      cell(fragment, 'id', customer.id);
      cell(fragment, 'name', customer.full_name);
      cell(fragment, 'email', customer.email);
      cell(fragment, 'phone', customer.phone);
      cell(fragment, 'created', date(customer.created_at));
      select('#admin-customers-body').append(fragment);
    }
  }
  if (view === 'mail') {
    const result = await request('/mail');
    const labels = {
      queued: 'في الطابور',
      processing: 'جارٍ الإرسال',
      sent: 'مرسل',
      failed: 'فشل الإرسال',
      cancelled: 'ملغي / رابط منتهٍ',
    };
    for (const job of result.messages) {
      const fragment = clone('mail-row');
      cell(fragment, 'id', job.id);
      cell(fragment, 'recipient', job.recipient);
      cell(fragment, 'subject', job.subject);
      cell(fragment, 'status', labels[job.status]);
      cell(fragment, 'attempts', job.attempts);
      cell(fragment, 'error', job.last_error);
      const retry = select('[data-action="retry-mail"]', fragment);
      retry.dataset.id = job.id;
      retry.hidden = job.status !== 'failed';
      select('#admin-mail-body').append(fragment);
    }
  }
  if (view === 'audit') {
    for (const event of (await request('/audit')).events) {
      const fragment = clone('audit-row');
      cell(fragment, 'date', date(event.created_at));
      cell(fragment, 'admin', event.admin_name);
      cell(fragment, 'action', event.action);
      cell(fragment, 'entity', `${event.entity_type} #${event.entity_id}`);
      cell(
        fragment,
        'details',
        JSON.stringify({ before: event.before_data, after: event.after_data }, null, 2),
      );
      select('#admin-audit-body').append(fragment);
    }
  }
}

/** نموذج المنتج يحتفظ برقم النسخة لمنع الكتابة فوق مخزون أو تعديل أحدث. */
function editProduct(id = null) {
  const product = id === null ? null : state.products.find((entry) => entry.id === Number(id));
  state.editingProduct = product;
  const form = select('#product-editor');
  form.reset();
  form.hidden = false;
  select('#product-editor-title').textContent = product ? `تعديل ${product.name}` : 'إضافة منتج';
  for (const key of ['name', 'sku', 'price', 'category', 'tag', 'fit', 'description', 'color']) {
    form.elements[key].value =
      product?.[key] ?? (key === 'category' ? 'tee' : key === 'color' ? '#181b22' : '');
  }
  form.elements.active.checked = product ? product.active : true;
  form.elements.images.value = product?.images.map((image) => image.path).join('\n') || '';
  select('#stock-fields').replaceChildren();
  for (const size of SIZES) {
    const fragment = clone('stock');
    const input = select('input', fragment);
    input.id = `stock-${size}`;
    input.name = `stock-${size}`;
    input.value = product?.sizes.find((entry) => entry.code === size)?.stock || 0;
    select('label', fragment).htmlFor = input.id;
    select('label', fragment).textContent = size;
    select('#stock-fields').append(fragment);
  }
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function editOrder(id) {
  const order = state.orders.find((entry) => entry.id === String(id));
  state.editingOrder = order;
  const form = select('#order-editor');
  form.reset();
  form.hidden = false;
  select('#order-editor-title').textContent = `إدارة الطلب ${order.number}`;
  select('#order-editor-customer').textContent =
    `${order.customer.name} · ${order.customer.email} · ${order.status}`;
  const options = select('#order-status');
  options.replaceChildren();
  for (const value of [order.statusCode, ...TRANSITIONS[order.statusCode]]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = STATUS_LABELS[value];
    options.append(option);
  }
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function handleSubmit(event) {
  const form = event.target;
  if (!['admin-login-form', 'product-editor', 'order-editor'].includes(form.id)) return;
  event.preventDefault();
  const button = form.querySelector('[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  select('#admin-error').textContent = '';
  try {
    const data = Object.fromEntries(new FormData(form));
    if (form.id === 'admin-login-form') {
      const result = await request('/login', 'POST', {
        identifier: data.identifier,
        password: data.password,
      });
      state.user = result.user;
      state.csrf = result.csrf;
      form.reset();
      select('#admin-name').textContent = state.user.name;
      select('#admin-login').hidden = true;
      select('#admin-shell').hidden = false;
      await loadView();
    }
    if (form.id === 'product-editor') {
      const body = {
        name: data.name,
        sku: data.sku,
        price: Number(data.price),
        category: data.category,
        tag: data.tag,
        fit: data.fit,
        description: data.description,
        color: data.color,
        active: form.elements.active.checked,
        images: data.images
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean)
          .map((path) => ({ path, alt: data.name })),
        sizes: SIZES.map((code) => ({ code, stock: Number(data[`stock-${code}`]) })),
        ...(state.editingProduct ? { version: state.editingProduct.version } : {}),
      };
      const result = await request(
        state.editingProduct ? `/products/${state.editingProduct.id}` : '/products',
        state.editingProduct ? 'PUT' : 'POST',
        body,
      );
      await loadView('products');
      message(result.message);
    }
    if (form.id === 'order-editor') {
      const result = await request(`/orders/${state.editingOrder.id}/status`, 'PATCH', {
        status: data.status,
        note: data.note,
        notify: form.elements.notify.checked,
      });
      await loadView('orders');
      message(result.message);
    }
  } catch (error) {
    showError(error);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function handleClick(event) {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.view) return loadView(button.dataset.view);
  if (button.hasAttribute('data-refresh')) return loadView();
  if (button.id === 'new-product') return editProduct();
  if (button.id === 'cancel-product') {
    select('#product-editor').hidden = true;
    return;
  }
  if (button.id === 'admin-logout') {
    await request('/logout', 'POST', {});
    showLogin();
    message('تم تسجيل الخروج. حساب الأدمن محفوظ.');
    return;
  }
  if (button.dataset.action === 'edit-product') return editProduct(button.dataset.id);
  if (button.dataset.action === 'edit-order') return editOrder(button.dataset.id);
  if (['send-invoice', 'retry-mail'].includes(button.dataset.action)) {
    button.disabled = true;
    try {
      const result =
        button.dataset.action === 'send-invoice'
          ? await request(`/orders/${button.dataset.id}/send-invoice`, 'POST', {
              requestId: crypto.randomUUID(),
            })
          : await request(`/mail/${button.dataset.id}/retry`, 'POST', {});
      message(result.message);
      if (state.view === 'mail') await loadView('mail');
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }
}

document.addEventListener('submit', handleSubmit);
document.addEventListener('click', (event) => {
  handleClick(event).catch(showError);
});

try {
  const session = await request('/session');
  if (session.user) {
    state.user = session.user;
    state.csrf = session.csrf;
    select('#admin-name').textContent = session.user.name;
    select('#admin-login').hidden = true;
    select('#admin-shell').hidden = false;
    await loadView();
  }
} catch (error) {
  showError(error);
}
