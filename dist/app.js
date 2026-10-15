import { api } from './api.js';

/**
 * STOR — JavaScript للسلوك فقط، دون سلاسل HTML أو تنسيقات ثابتة.
 * الفهرس: البيانات → التخزين → المكونات → الصفحات → الصور → العمليات → الأحداث.
 * HTML: القوالب في index.html. CSS: كل قواعد العرض في style.css.
 * الحساب والطلبات من MySQL؛ كلمات المرور لا تحفظ في المتصفح.
 */
(() => {
  'use strict';

  // ============================================================
  // 1. بيانات المنتجات والإعدادات
  // ============================================================
  const SETTINGS = {
    shipping: 15,
    maxQuantity: 20,
    maxCachedColors: 12,
    toastDuration: 2800,
  };

  // الكتالوج يأتي من MySQL عبر API؛ لا توجد أسعار أو منتجات ثابتة في الواجهة.
  let PRODUCTS = [];
  const COLORS = [
    {
      name: 'أسود',
      value: '#181b22',
    },
    {
      name: 'أبيض',
      value: '#eeeade',
    },
    {
      name: 'رمادي',
      value: '#9ca3af',
    },
    {
      name: 'بنفسجي',
      value: '#8c55ed',
    },
    {
      name: 'أزرق',
      value: '#2863cd',
    },
    {
      name: 'أحمر',
      value: '#d74456',
    },
    {
      name: 'أخضر',
      value: '#168c70',
    },
  ];
  const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
  const moneyFormatter = new Intl.NumberFormat('ar-SA');
  const dateFormatter = new Intl.DateTimeFormat('ar-SA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  /** البحث عن منتج بالمعرف؛ undefined يعني أن الرابط غير صحيح. */
  function findProduct(id) {
    return PRODUCTS.find((product) => product.id === Number(id));
  }
  /** تنسيق السعر بأرقام عربية وعملة الريال في جميع الواجهات. */
  function formatMoney(amount) {
    return `${moneyFormatter.format(amount)} ر.س`;
  }
  /** تحديد مسار الصورة الأصلية للمنتج داخل مجلد assets. */
  function imagePath(product) {
    return product?.images?.[0]?.path || 'assets/front.png';
  }
  /** إرجاع اسم اللون الجاهز أو رمز اللون المخصص. */
  function colorLabel(color) {
    return COLORS.find((entry) => entry.value === color)?.name || `لون مخصص (${color})`;
  }

  // ============================================================
  // 2. التخزين المحلي وحالة التطبيق
  // ============================================================

  /** فشل التخزين أو تلف JSON لا يمنع تشغيل الواجهة. */
  function readStorage(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(`stor-${key}`)) ?? fallback;
    } catch {
      return fallback;
    }
  }
  /** حفظ JSON محليًا مع إظهار تنبيه إذا منع المتصفح التخزين. */
  function writeStorage(key, value) {
    try {
      localStorage.setItem(`stor-${key}`, JSON.stringify(value));
    } catch {
      showToast('تعذّر الحفظ على الجهاز. تبقى البيانات متاحة خلال الجلسة الحالية.');
    }
  }

  /** التحقق من سطر سلة قديم قبل استخدامه؛ مفاتيح التخزين توافق النسخة السابقة. */
  function validItem(item) {
    return (
      item &&
      Number.isInteger(item.id) &&
      SIZES.includes(item.size) &&
      HEX_PATTERN.test(item.color) &&
      Number.isInteger(item.qty) &&
      item.qty >= 1 &&
      item.qty <= SETTINGS.maxQuantity
    );
  }
  // الحساب والطلبات والمفضلة من MySQL؛ السلة قبل الشراء محلية فقط.
  const savedCart = readStorage('cart', []);
  const state = {
    cart: Array.isArray(savedCart) ? savedCart.filter(validItem) : [],
    orders: [],
    favorites: [],
    profile: null,
    addresses: [],
    filter: 'all',
    category: 'tee',
    query: '',
    sort: 'new',
    detail: null,
  };
  let returnAfterLogin = null;
  let checkoutKey = null;
  let toastTimer;
  let renderVersion = 0;
  let previewRequest = 0;
  let neutralImagePromise;
  const previewCache = new Map();
  const app = document.querySelector('#app');

  // ============================================================
  // 3. أدوات DOM وقوالب HTML والمكونات المشتركة
  // ============================================================

  /** البحث عن عنصر داخل الصفحة أو داخل جزء HTML محدد. */
  function select(selector, root = document) {
    return root.querySelector(selector);
  }

  /** نسخ القالب من HTML بدل إنشاء الواجهة داخل نص طويل في JavaScript. */
  function cloneTemplate(name) {
    return document.getElementById(`${name}-template`).content.cloneNode(true);
  }

  /** data-bind يحدد مكان تعبئة بيانات كل مكون مشترك. */
  function binding(fragment, name) {
    return select(`[data-bind="${name}"]`, fragment);
  }

  /** textContent يمنع تفسير مدخلات المستخدم على أنها HTML. */
  function setText(selector, text, root = document) {
    const element = select(selector, root);
    if (element) element.textContent = text;
  }

  /** نسخ SVG من مكتبة الرموز الثابتة في HTML. */
  function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((target) => {
      const source = document.getElementById(`icon-${target.dataset.icon}`);
      if (!source) return;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      source.childNodes.forEach((node) => svg.append(node.cloneNode(true)));
      target.replaceChildren(svg);
    });
  }
  /** إظهار رسالة حالة مؤقتة ثم إخفاؤها دون تعطيل الصفحة. */
  function showToast(message) {
    setText('#toast', message);
    select('#toast').classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      select('#toast').classList.remove('is-visible');
    }, SETTINGS.toastDuration);
  }
  /** تعبئة قالب العنوان ورابط الرجوع والوصف الاختياري. */
  function appendHeading(title, back = 'home', subtitle = '') {
    const fragment = cloneTemplate('page-heading');
    binding(fragment, 'title').textContent = title;
    binding(fragment, 'back').href = `#${back}`;
    binding(fragment, 'subtitle').textContent = subtitle;
    binding(fragment, 'subtitle').hidden = !subtitle;
    app.append(fragment);
  }
  /** عرض حالة فارغة مع رابط واضح للمتابعة. */
  function appendEmpty(title, action, route, message = '', container = app) {
    const fragment = cloneTemplate('empty');
    binding(fragment, 'title').textContent = title;
    binding(fragment, 'message').textContent = message;
    binding(fragment, 'action').textContent = action;
    binding(fragment, 'action').href = `#${route}`;
    container.append(fragment);
    hydrateIcons(container);
  }

  /** الشحن لا يحتسب على السلة الفارغة. */
  function calculateTotals(items = state.cart) {
    const subtotal = items.reduce((total, item) => total + item.price * item.qty, 0);
    const shipping = items.length ? SETTINGS.shipping : 0;
    return {
      subtotal,
      shipping,
      total: subtotal + shipping,
    };
  }
  /** عرض المجموع والشحن والإجمالي من القالب المشترك. */
  function appendTotals(container, items = state.cart) {
    const fragment = cloneTemplate('totals');
    const totals = calculateTotals(items);
    ['subtotal', 'shipping', 'total'].forEach((key) => {
      binding(fragment, key).textContent = formatMoney(totals[key]);
    });
    container.append(fragment);
  }

  /** الشراء يفتح تفاصيل المنتج لاختيار اللون والمقاس قبل إضافته. */
  function createProductCard(product) {
    const fragment = cloneTemplate('product-card');
    const href = `#product/${product.id}`;
    binding(fragment, 'link').href = href;
    binding(fragment, 'link').ariaLabel = `عرض ${product.name}`;
    binding(fragment, 'name-link').href = href;
    binding(fragment, 'image').src = imagePath(product);
    binding(fragment, 'image').alt = product.name;
    binding(fragment, 'name').textContent = product.name;
    binding(fragment, 'tag').textContent = product.tag;
    binding(fragment, 'price').textContent = formatMoney(product.price);
    const buy = binding(fragment, 'buy');
    buy.textContent = product.available ? 'أضف إلى السلة' : 'نفدت الكمية';
    buy.disabled = !product.available;
    buy.dataset.openProduct = product.id;
    return fragment;
  }
  /** عرض عناصر الطلب في مراجعة الدفع والفاتورة. */
  function appendSummaryItems(container, items) {
    items.forEach((item) => {
      const fragment = cloneTemplate('summary-item');
      binding(fragment, 'name').textContent = item.name || findProduct(item.id)?.name || 'منتج';
      binding(fragment, 'details').textContent =
        `المقاس ${item.size} · ${colorLabel(item.color)} · كمية ${item.qty}`;
      binding(fragment, 'price').textContent = formatMoney(item.price * item.qty);
      container.append(fragment);
    });
  }

  // ============================================================
  // 4. الصفحات والتوجيه؛ hash لا يحتاج إعداد مسارات على الخادم
  // ============================================================

  /** قراءة اسم الصفحة ومعرفها من hash مثل product/1. */
  function getRoute() {
    const [name, id = '', portal = 'customer'] = (location.hash.slice(1) || 'home').split('/');
    return { name, id, portal };
  }
  /** الانتقال لصفحة أو إعادة عرض الصفحة الحالية عند الحاجة. */
  function navigate(route) {
    if (location.hash === `#${route}`) renderPage();
    else location.hash = route;
  }

  /** الشارة والرابط النشط فقط؛ الترويسة ثابتة ولا تحتاج إعادة إنشائها. */
  function updateNavigation() {
    const route = getRoute().name;
    const sections = {
      product: 'products',
      favorites: 'products',
      login: 'account',
      register: 'account',
      profile: 'account',
      invoice: 'orders',
      tracking: 'orders',
      success: 'orders',
    };
    const activeSection = sections[route] || route;
    document.querySelectorAll('[data-nav]').forEach((link) => {
      if (link.dataset.nav === activeSection) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    const count = state.cart.reduce((total, item) => total + item.qty, 0);
    setText('#cart-count', count);
    select('#cart-count').hidden = !count;
    select('#cart-link').ariaLabel = `السلة، ${count} منتجات`;
  }
  /** عرض القسم الترحيبي وأحدث المنتجات من قالب الرئيسية. */
  function renderHome() {
    app.append(cloneTemplate('home'));
    renderHomeProducts();
  }

  /** تبديل تبويب الرئيسية يحدث الشبكة فقط دون القفز لأعلى الصفحة. */
  function renderHomeProducts() {
    const container = select('#home-products');
    container.replaceChildren();
    PRODUCTS.filter((product) => product.category === state.category)
      .slice(0, 3)
      .forEach((product) => container.append(createProductCard(product)));
    document.querySelectorAll('[data-category]').forEach((button) => {
      button.setAttribute('aria-pressed', button.dataset.category === state.category);
    });
  }
  /** عرض صفحة المنتجات أو المفضلة بالقالب نفسه. */
  function renderCatalog(favoritesOnly = false) {
    appendHeading(
      favoritesOnly ? 'المفضلة' : 'المنتجات',
      'home',
      'اختر تصميمك، ثم خصّص اللون والمقاس.',
    );
    app.append(cloneTemplate('catalog'));
    select('#product-search').value = state.query;
    select('#product-sort').value = state.sort;
    setText('#catalog-title', favoritesOnly ? 'منتجاتك المفضلة' : 'كل المنتجات');
    updateCatalogResults();
  }

  /** تحديث النتائج فقط يحافظ على التركيز أثناء البحث. */
  function updateCatalogResults() {
    const favoritesOnly = getRoute().name === 'favorites';
    const results = PRODUCTS.filter(
      (product) =>
        (!favoritesOnly || state.favorites.includes(product.id)) &&
        (state.filter !== 'available' || product.available) &&
        product.name.includes(state.query.trim()),
    );
    if (state.sort === 'low') results.sort((a, b) => a.price - b.price);
    if (state.sort === 'high') results.sort((a, b) => b.price - a.price);
    const container = select('#product-results');
    container.replaceChildren();
    results.forEach((product) => container.append(createProductCard(product)));
    setText('#result-count', `${results.length} منتجات`);
    document.querySelectorAll('[data-filter]').forEach((button) => {
      button.setAttribute('aria-pressed', button.dataset.filter === state.filter);
    });
    if (!results.length) {
      appendEmpty(
        'لا توجد منتجات مطابقة',
        'الرئيسية',
        'home',
        'جرّب تغيير كلمة البحث أو خيار التوفر.',
        container,
      );
    }
  }

  /** تبقى اختيارات المنتج محفوظة خلال التنقل الحالي. */
  function renderProduct(id) {
    const product = findProduct(id);
    appendHeading('تفاصيل المنتج', 'products');
    if (!product) {
      appendEmpty('المنتج غير موجود', 'المنتجات', 'products');
      return;
    }
    if (state.detail?.id !== product.id) {
      state.detail = {
        id: product.id,
        color: product.color,
        size: '',
        quantity: 1,
        view: 0,
      };
    }
    app.append(cloneTemplate('product'));
    setText('#product-title', product.name);
    setText('#product-tag', product.tag);
    setText('#product-description', `${product.fit}، بتصميم بسيط لإطلالة كل يوم.`);
    setText('#product-price', formatMoney(product.price));
    setText('#product-stock', product.available ? 'متوفر للطلب' : 'غير متوفر حاليًا');
    select('#add-to-cart').disabled = !product.available;
    setText('#add-to-cart', product.available ? 'أضف إلى السلة' : 'نفدت الكمية');
    setText('#size-value', state.detail.size || 'اختر مقاسك');
    setText('#product-quantity', state.detail.quantity);
    select('#shirt-image').src = imagePath(product);
    product.images.slice(1).forEach((photo, index) => {
      const button = select('[data-view="0"]').cloneNode(true);
      button.dataset.view = index + 3;
      button.ariaLabel = `الصورة ${index + 2}`;
      select('img', button).src = photo.path;
      select('span', button).textContent = `الصورة ${index + 2}`;
      select('.gallery-thumbnails').append(button);
    });
    COLORS.forEach((color) => {
      const fragment = cloneTemplate('color-option');
      const button = fragment.querySelector('button');
      button.dataset.color = color.value;
      button.ariaLabel = `اللون ${color.name}`;
      binding(fragment, 'name').textContent = color.name;
      // خلفية اللون قيمة بيانات متغيرة؛ قواعد العرض جميعها في CSS.
      select('.color-dot', fragment).style.backgroundColor = color.value;
      select('#color-options').append(fragment);
    });
    SIZES.forEach((size) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.size = size;
      button.textContent = size;
      button.disabled = !product.sizes.some((entry) => entry.code === size && entry.stock > 0);
      button.setAttribute('aria-pressed', state.detail.size === size);
      select('#size-options').append(button);
    });
    updateFavoriteButton();
    updateColorControls();
    if (product.category === 'tee') paintProductPreview();
    else {
      // صورة التيشيرت المولدة لا تستخدم للسويتشرت.
      select('.option-section').hidden = true;
      select('.gallery-thumbnails').hidden = true;
      select('.gallery-note').hidden = true;
      select('#shirt-image').alt = product.name;
    }
  }

  /** إنشاء سطر مستقل لكل منتج/لون/مقاس مع معاينة اللون المختار. */
  function renderCart() {
    appendHeading('السلة', 'products', 'راجع اختياراتك قبل إتمام الطلب.');
    if (!state.cart.length) {
      appendEmpty('سلتك تنتظر اختياراتك', 'تصفح المنتجات', 'products');
      return;
    }
    app.append(cloneTemplate('cart'));
    state.cart.forEach((item, index) => {
      const product = findProduct(item.id);
      const fragment = cloneTemplate('cart-item');
      binding(fragment, 'link').href = `#product/${product.id}`;
      const image = binding(fragment, 'image');
      image.src = imagePath(product);
      image.alt = `${product.name} باللون المختار`;
      binding(fragment, 'name').textContent = product.name;
      binding(fragment, 'size').textContent = `المقاس: ${item.size}`;
      binding(fragment, 'color').textContent = colorLabel(item.color);
      binding(fragment, 'swatch').style.backgroundColor = item.color;
      binding(fragment, 'quantity').textContent = item.qty;
      binding(fragment, 'price').textContent = formatMoney(item.price * item.qty);
      ['decrease', 'increase'].forEach((action) => {
        const button = binding(fragment, action);
        button.dataset.cartIndex = index;
        button.dataset.delta = action === 'decrease' ? -1 : 1;
        button.disabled = action === 'decrease' ? item.qty <= 1 : item.qty >= SETTINGS.maxQuantity;
      });
      binding(fragment, 'remove').dataset.removeIndex = index;
      binding(fragment, 'remove').ariaLabel = `حذف ${product.name}`;
      select('#cart-items').append(fragment);
      paintCartImage(image, item.color);
    });
    appendTotals(select('#cart-totals'));
  }

  /** HTML يتحقق من صحة الاسم والجوال والعنوان قبل حدث submit. */
  function renderCheckout() {
    appendHeading('إتمام الطلب', 'cart');
    if (!state.cart.length) return appendEmpty('السلة فارغة', 'تصفح المنتجات', 'products');
    app.append(cloneTemplate('checkout'));
    select('#full-name').value = state.profile.name;
    select('#customer-email').value = state.profile.email;
    select('#customer-email').readOnly = true;
    appendSummaryItems(select('#checkout-items'), state.cart);
    appendTotals(select('#checkout-totals'));
    const fingerprint = JSON.stringify(
      state.cart.map((item) => [item.id, item.size, item.color, item.qty]),
    );
    const draft = readStorage('checkoutDraft', null);
    checkoutKey =
      draft?.fingerprint === fingerprint && /^[a-f0-9-]{36}$/i.test(draft.key)
        ? draft.key
        : crypto.randomUUID();
    writeStorage('checkoutDraft', { fingerprint, key: checkoutKey });
  }
  /** عرض رقم الطلب المحفوظ وروابط المتابعة والفاتورة. */
  function renderSuccess() {
    const order = state.orders[0];
    if (!order) {
      appendEmpty('لا يوجد طلب بعد', 'تصفح المنتجات', 'products');
      return;
    }
    app.append(cloneTemplate('success'));
    setText('#success-number', `رقم الطلب ${order.number}`);
    select('#track-order').href = `#tracking/${order.id}`;
    select('#view-invoice').href = `#invoice/${order.id}`;
  }
  /** عرض طلبات الحساب من MySQL وتواريخها وإجمالياتها. */
  function renderOrders() {
    appendHeading('طلباتي', 'account', 'طلباتك وفواتيرك المحفوظة في المتجر.');
    if (!state.orders.length) {
      appendEmpty('لا توجد طلبات حتى الآن', 'ابدأ التسوق', 'products');
      return;
    }
    app.append(cloneTemplate('orders'));
    state.orders.forEach((order) => {
      const fragment = cloneTemplate('order-card');
      binding(fragment, 'link').href = `#tracking/${order.id}`;
      binding(fragment, 'number').textContent = `طلب ${order.number}`;
      select('.order-status', fragment).textContent = order.status;
      binding(fragment, 'date').textContent = dateFormatter.format(new Date(order.date));
      binding(fragment, 'items').textContent =
        `${order.items.reduce((sum, item) => sum + item.qty, 0)} قطع`;
      binding(fragment, 'total').textContent = formatMoney(calculateTotals(order.items).total);
      select('#orders-list').append(fragment);
    });
  }

  /** رابط طلب غير موجود يعرض رسالة واضحة بدل صفحة معطلة. */
  function findOrderOrShowEmpty(id) {
    const order = state.orders.find((entry) => String(entry.id) === id);
    if (!order) appendEmpty('لم يتم العثور على الطلب', 'طلباتي', 'orders');
    return order;
  }
  /** جمع المدينة والحي والشارع في نص عنوان واضح. */
  function orderAddress(order) {
    return [order.customer.city, order.customer.district, order.customer.street]
      .filter(Boolean)
      .join('، ');
  }
  /** عرض مراحل الطلب المحفوظ وعنوان العميل. */
  function renderTracking(id) {
    appendHeading('تتبع الطلب', 'orders');
    const order = findOrderOrShowEmpty(id);
    if (!order) return;
    app.append(cloneTemplate('tracking'));
    setText('#tracking-number', `طلب ${order.number}`);
    setText('#tracking-name', order.customer.name);
    setText('#tracking-address', orderAddress(order));
    select('#tracking-invoice').href = `#invoice/${order.id}`;
    const timeline = select('.timeline');
    timeline.replaceChildren();
    const steps =
      order.statusCode === 'cancelled'
        ? [['cancelled', 'ملغي']]
        : [
            ['pending', 'قيد التجهيز'],
            ['shipped', 'تم الشحن'],
            ['out_for_delivery', 'جاري التوصيل'],
            ['delivered', 'تم التسليم'],
          ];
    for (const [code, label] of steps) {
      const fragment = cloneTemplate('order-step');
      const event = order.history.find((item) => item.status_code === code);
      select('li', fragment).classList.toggle('completed', Boolean(event));
      select('h3', fragment).textContent = label;
      select('small', fragment).textContent = event
        ? dateFormatter.format(new Date(event.date))
        : 'بانتظار تحديث الحالة';
      timeline.append(fragment);
    }
  }
  /** تعبئة الفاتورة بعناصر الطلب وعنوانه وإجمالياته. */
  function renderInvoice(id) {
    appendHeading('فاتورة الطلب', 'orders');
    const order = findOrderOrShowEmpty(id);
    if (!order) return;
    app.append(cloneTemplate('invoice'));
    setText('#invoice-number', order.invoiceNumber);
    setText('#invoice-date', dateFormatter.format(new Date(order.date)));
    setText('#invoice-name', order.customer.name);
    setText('#invoice-address', orderAddress(order));
    appendSummaryItems(select('#invoice-items'), order.items);
    appendTotals(select('#invoice-totals'), order.items);
  }
  /** عرض ملف العميل وروابط الإعدادات وحالة الدخول. */
  function renderAccount() {
    appendHeading('حسابي', 'home', 'إدارة معلوماتك واختياراتك.');
    app.append(cloneTemplate('account'));
    setText('#profile-initial', (state.profile?.name || 'زائر')[0]);
    setText('#profile-name', state.profile?.name || 'أهلًا بك في STOR');
    setText('#profile-email', state.profile?.email || 'اختر الألوان التي تشبهك');
    select('#account-login').hidden = Boolean(state.profile);
    select('#logout-button').hidden = !state.profile;
  }

  /** نموذج واحد للدخول والتسجيل؛ الحقول المخفية تكون معطلة أيضًا. */
  function renderAuth(register = false) {
    app.append(cloneTemplate('auth'));
    setText('#auth-title', register ? 'إنشاء حساب' : 'تسجيل الدخول');
    setText(
      '#auth-description',
      register ? 'املأ بياناتك لبدء تجربة المتجر.' : 'مرحبًا! سجل الدخول لمتابعة طلباتك.',
    );
    setText('#auth-submit', register ? 'إنشاء حساب' : 'تسجيل الدخول');
    setText('#auth-switch', register ? 'لديك حساب؟ تسجيل الدخول' : 'ليس لديك حساب؟ سجل الآن');
    select('#auth-switch').href = register ? '#login' : '#register';
    select('#register-name-field').hidden = !register;
    select('#auth-name').required = register;
    select('#auth-name').disabled = !register;
    select('#confirm-password-field').hidden = !register;
    select('#auth-confirm').required = register;
    select('#auth-confirm').disabled = !register;
    select('#auth-password').autocomplete = register ? 'new-password' : 'current-password';
  }
  /** عرض نموذج تعديل الاسم والبريد مع القيم الحالية. */
  function renderProfile() {
    appendHeading('بيانات الحساب', 'account');
    app.append(cloneTemplate('profile'));
    select('#profile-full-name').value = state.profile?.name || '';
    select('#profile-mail').value = state.profile?.email || '';
    select('#profile-mail').readOnly = true;
  }

  /** نقطة العرض المركزية تلغي الصور القديمة وتحدّث التنقل والعنوان والتركيز. */
  async function renderPage({ preserveScroll = false } = {}) {
    const version = ++renderVersion;
    previewRequest += 1;
    const route = getRoute();
    const scroll = window.scrollY;
    const pending = cloneTemplate('loading');
    app.replaceChildren(pending);
    try {
      if ((await loadPageData(route)) === false || version !== renderVersion) return;
      const pages = {
        home: renderHome,
        products: () => renderCatalog(false),
        favorites: () => renderCatalog(true),
        product: () => renderProduct(route.id),
        cart: renderCart,
        checkout: renderCheckout,
        success: renderSuccess,
        orders: renderOrders,
        tracking: () => renderTracking(route.id),
        invoice: () => renderInvoice(route.id),
        account: renderAccount,
        login: () => renderAuth(false),
        register: () => renderAuth(true),
        profile: renderProfile,
        'forgot-password': renderForgotPassword,
        'reset-password': renderResetPassword,
        addresses: renderAddresses,
      };
      app.replaceChildren();
      (pages[route.name] || renderHome)();
      hydrateIcons(app);
      updateNavigation();
      document.title = `${select('h1', app)?.textContent || 'المتجر'} | STOR`;
      if (preserveScroll) window.scrollTo(0, scroll);
      else {
        window.scrollTo(0, 0);
        app.focus({ preventScroll: true });
      }
    } catch (error) {
      if (version !== renderVersion) return;
      if (error.status === 401) {
        state.profile = null;
        navigate('login');
        return;
      }
      app.replaceChildren();
      appendEmpty(
        'تعذر تحميل البيانات',
        'إعادة المحاولة',
        route.name,
        error.message || 'تأكد من تشغيل خادم Node.js وإعداد MySQL.',
      );
    }
  }

  // ============================================================
  // 5. معاينة لون القماش: Canvas والذاكرة المؤقتة
  // ============================================================

  /** تحميل واحد وتصغير نسخة العمل لتحسين سرعة معاينة الألوان. */
  async function getNeutralImage() {
    if (!neutralImagePromise) {
      neutralImagePromise = (async () => {
        const image = new Image();
        image.src = 'assets/front.png';
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 768;
        canvas.height = Math.round((image.naturalHeight * canvas.width) / image.naturalWidth);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas;
      })();
    }
    return neutralImagePromise;
  }

  /**
   * ضرب RGB في إضاءة البكسل يحتفظ بثنيات القماش وظلاله.
   * قناة Alpha لا تتغير للحفاظ على شفافية الخلفية.
   * تُحفظ آخر 12 معاينة فقط لتقييد استهلاك الذاكرة.
   */
  async function createTintedPreview(color) {
    if (previewCache.has(color)) return previewCache.get(color);
    const source = await getNeutralImage();
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d');
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const rgb = color
      .slice(1)
      .match(/../g)
      .map((value) => parseInt(value, 16));
    for (let index = 0; index < pixels.data.length; index += 4) {
      if (!pixels.data[index + 3]) continue;
      const luminance =
        (pixels.data[index] * 0.2126 +
          pixels.data[index + 1] * 0.7152 +
          pixels.data[index + 2] * 0.0722) /
        180;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels.data[index + channel] = Math.min(255, rgb[channel] * luminance);
      }
    }
    context.putImageData(pixels, 0, 0);
    const url = canvas.toDataURL('image/png');
    if (previewCache.size >= SETTINGS.maxCachedColors) {
      previewCache.delete(previewCache.keys().next().value);
    }
    previewCache.set(color, url);
    return url;
  }

  /** رقم الطلب يمنع ظهور لون قديم بعد اختيار لون أحدث أو تغيير الصفحة. */
  async function paintProductPreview() {
    const snapshot = {
      ...state.detail,
    };
    const product = findProduct(snapshot.id);
    const request = ++previewRequest;
    const version = renderVersion;
    try {
      const front = await createTintedPreview(snapshot.color);
      if (request !== previewRequest || version !== renderVersion) return;
      const image = select('#shirt-image');
      if (!image) return;
      image.src =
        snapshot.view === 0
          ? imagePath(product)
          : snapshot.view > 2
            ? product.images[snapshot.view - 2].path
            : front;
      image.classList.toggle('is-front', snapshot.view === 1 || snapshot.view === 2);
      image.classList.toggle('is-detail', snapshot.view === 2);
      image.alt =
        snapshot.view === 0
          ? `${product.name} — الصورة الأصلية`
          : `معاينة ${product.name} بلون ${colorLabel(snapshot.color)}`;
      document.querySelectorAll('[data-view]').forEach((button) => {
        const view = Number(button.dataset.view);
        button.setAttribute('aria-pressed', view === snapshot.view);
        select('img', button).src =
          view === 0 ? imagePath(product) : view > 2 ? product.images[view - 2].path : front;
      });
    } catch {
      if (version === renderVersion) showToast('تعذّر تحميل معاينة اللون. الصورة الأصلية متاحة.');
    }
  }

  /** التحقق من بقاء الصورة في DOM قبل تحديث سطر سلة تغير أو حُذف. */
  async function paintCartImage(image, color) {
    try {
      const src = await createTintedPreview(color);
      if (image.isConnected) image.src = src;
    } catch {
      // تبقى الصورة الأصلية ظاهرة إذا لم يتمكن المتصفح من إنشاء المعاينة.
    }
  }
  /** مزامنة اسم اللون وحقل HEX والألوان الجاهزة. */
  function updateColorControls() {
    const color = state.detail.color;
    select('#custom-color').value = color;
    select('#hex-color').value = color;
    setText('#color-name', colorLabel(color));
    document.querySelectorAll('[data-color]').forEach((button) => {
      const active = button.dataset.color === color;
      button.setAttribute('aria-pressed', active);
      select('.color-dot', button).textContent = active ? '✓' : '';
    });
  }
  /** اعتماد اللون الصحيح والانتقال إلى معاينته الأمامية. */
  function changeColor(color) {
    if (!HEX_PATTERN.test(color)) return;
    state.detail.color = color.toLowerCase();
    state.detail.view = 1;
    updateColorControls();
    paintProductPreview();
  }

  // ============================================================
  // 6. عمليات المنتج والسلة والنماذج
  // ============================================================

  /** hidden وaria-expanded متزامنان لدعم لوحة المفاتيح وقارئ الشاشة. */
  function toggleSizes(open = select('#size-options').hidden) {
    select('#size-options').hidden = !open;
    select('#size-button').setAttribute('aria-expanded', open);
  }
  /** حفظ المقاس المختار وإغلاق القائمة وإعادة التركيز. */
  function chooseSize(size) {
    if (!SIZES.includes(size)) return;
    state.detail.size = size;
    setText('#size-value', size);
    setText('#size-error', '');
    document.querySelectorAll('[data-size]').forEach((button) => {
      button.setAttribute('aria-pressed', button.dataset.size === size);
    });
    toggleSizes(false);
    select('#size-button').focus();
  }
  /** مزامنة حالة زر المفضلة وتسميته مع بيانات المستخدم. */
  function updateFavoriteButton() {
    const favorite = state.favorites.includes(state.detail.id);
    const button = select('#favorite-button');
    button.setAttribute('aria-pressed', favorite);
    button.ariaLabel = `${favorite ? 'إزالة من' : 'إضافة إلى'} المفضلة`;
  }
  /** إضافة المنتج للمفضلة أو إزالته وحفظ التغيير. */
  async function toggleFavorite() {
    if (!state.profile) {
      returnAfterLogin = `product/${state.detail.id}`;
      navigate('login');
      return;
    }
    const id = state.detail.id;
    const favorite = !state.favorites.includes(id);
    await api.favorite({ productId: id, favorite });
    state.favorites = favorite
      ? [...state.favorites, id]
      : state.favorites.filter((entry) => entry !== id);
    updateFavoriteButton();
    showToast(favorite ? 'حُفظ المنتج في المفضلة.' : 'أُزيل المنتج من المفضلة.');
  }

  /** الدمج يحدث فقط عند تطابق المنتج والمقاس واللون. */
  function addToCart() {
    const detail = state.detail;
    const product = findProduct(detail.id);
    if (!product.available) return;
    if (!detail.size) {
      setText('#size-error', 'اختر المقاس أولًا لإضافة المنتج إلى السلة.');
      toggleSizes(true);
      select('#size-button').focus();
      return;
    }
    const existing = state.cart.find(
      (item) => item.id === product.id && item.size === detail.size && item.color === detail.color,
    );
    if (existing) {
      existing.qty = Math.min(SETTINGS.maxQuantity, existing.qty + detail.quantity);
    } else {
      state.cart.push({
        id: product.id,
        price: product.price,
        size: detail.size,
        color: detail.color,
        colorName: colorLabel(detail.color),
        qty: detail.quantity,
      });
    }
    writeStorage('cart', state.cart);
    updateNavigation();
    showToast('أُضيف المنتج إلى السلة باللون والمقاس المختارين');
  }

  /** المحافظة على موضع الصفحة والتركيز عند تغيير الكمية. */
  function changeCartQuantity(index, delta) {
    const item = state.cart[index];
    if (!item) return;
    item.qty = Math.max(1, Math.min(SETTINGS.maxQuantity, item.qty + delta));
    writeStorage('cart', state.cart);
    renderPage({
      preserveScroll: true,
    });
    select(`[data-cart-index="${index}"][data-delta="${delta}"]`)?.focus({
      preventScroll: true,
    });
  }
  /** حذف سطر من السلة وتحديث الصفحة دون القفز لأعلاها. */
  function removeCartItem(index) {
    if (!state.cart[index]) return;
    state.cart.splice(index, 1);
    writeStorage('cart', state.cart);
    renderPage({
      preserveScroll: true,
    });
    showToast('حُذف المنتج من السلة');
  }

  /** إنشاء طلب بالخادم مع تثبيت السعر والمخزون وطابور الفاتورة. */
  async function submitCheckout(form) {
    if (!state.cart.length) return;
    const data = Object.fromEntries(new FormData(form));
    const result = await api.checkout({
      checkoutKey,
      items: state.cart.map((item) => ({
        productId: item.id,
        size: item.size,
        color: item.color,
        quantity: item.qty,
      })),
      customer: {
        name: data.name,
        phone: data.phone,
        city: data.city,
        district: data.district,
        street: data.street,
        postal: data.postal || '',
        carrier: data.shipper,
      },
    });
    state.orders.unshift(result.order);
    state.cart = [];
    checkoutKey = null;
    writeStorage('checkoutDraft', null);
    writeStorage('cart', []);
    navigate('success');
  }

  /** كلمة المرور تستخدم للتحقق من تطابق حقلي التسجيل ولا تُحفظ. */
  async function submitAuth(form) {
    const data = Object.fromEntries(new FormData(form));
    const register = getRoute().name === 'register';
    if (register && data.password !== data.confirm) {
      setText('#auth-error', 'كلمتا المرور غير متطابقتين.');
      select('#auth-confirm').focus();
      return;
    }
    const result = register
      ? await api.register({ name: data.name, email: data.email, password: data.password })
      : await api.login({ identifier: data.email, password: data.password });
    form.reset();
    state.profile = result.user;
    state.favorites = (await api.favorites()).favorites;
    navigate(returnAfterLogin || 'account');
    returnAfterLogin = null;
    showToast(register ? 'تم إنشاء الحساب وحفظه في MySQL.' : 'تم تسجيل الدخول.');
  }
  /** حفظ الاسم والبريد ثم العودة إلى الحساب. */
  async function submitProfile(form) {
    const result = await api.profile({ name: new FormData(form).get('name') });
    state.profile = result.user;
    navigate('account');
    showToast('حُفظت بيانات الحساب في قاعدة البيانات.');
  }

  // ============================================================
  // 7. الأحداث: معالج مستقل لكل نوع حدث، ودالة واضحة لكل عملية
  // ============================================================

  /** تفويض الأحداث يربط أزرار القوالب تلقائيًا دون تكرار المستمعين. */
  function handleClick(event) {
    if (event.target.closest('.skip-link')) {
      event.preventDefault();
      app.focus();
      app.scrollIntoView();
      return;
    }
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.removeAddress) return removeAddress(button.dataset.removeAddress);
    if (button.dataset.openProduct) return navigate(`product/${button.dataset.openProduct}`);
    if (button.dataset.category) {
      state.category = button.dataset.category;
      return renderHomeProducts();
    }
    if (button.dataset.filter) {
      state.filter = button.dataset.filter;
      return updateCatalogResults();
    }
    if (button.dataset.color) return changeColor(button.dataset.color);
    if (button.dataset.view !== undefined) {
      state.detail.view = Number(button.dataset.view);
      return paintProductPreview();
    }
    if (button.dataset.size) return chooseSize(button.dataset.size);
    if (button.dataset.detailQuantity) {
      const next = state.detail.quantity + Number(button.dataset.detailQuantity);
      state.detail.quantity = Math.max(1, Math.min(SETTINGS.maxQuantity, next));
      return setText('#product-quantity', state.detail.quantity);
    }
    if (button.dataset.cartIndex !== undefined) {
      return changeCartQuantity(Number(button.dataset.cartIndex), Number(button.dataset.delta));
    }
    if (button.dataset.removeIndex !== undefined)
      return removeCartItem(Number(button.dataset.removeIndex));
    switch (button.id) {
      case 'size-button':
        toggleSizes();
        break;
      case 'favorite-button':
        toggleFavorite();
        break;
      case 'add-to-cart':
        addToCart();
        break;
      case 'print-invoice':
        window.print();
        break;
      case 'logout-button':
        return logoutCustomer();
      default:
        break;
    }
  }

  /** لا يُطبق رمز HEX الجزئي حتى تكتمل أرقامه الستة. */
  function handleInput(event) {
    const field = event.target;
    if (field.id === 'product-search') {
      state.query = field.value;
      updateCatalogResults();
    }
    if (field.id === 'custom-color') changeColor(field.value);
    if (field.id === 'hex-color' && HEX_PATTERN.test(field.value)) changeColor(field.value);
  }
  /** تحديث ترتيب الكتالوج عند تغيير القائمة المنسدلة. */
  function handleChange(event) {
    if (event.target.id === 'product-sort') {
      state.sort = event.target.value;
      updateCatalogResults();
    }
  }
  /** توجيه النموذج الصحيح إلى معالج الدفع أو الحساب المناسب. */
  async function handleSubmit(event) {
    const handlers = {
      'checkout-form': submitCheckout,
      'auth-form': submitAuth,
      'profile-form': submitProfile,
      'forgot-form': submitForgotPassword,
      'reset-form': submitResetPassword,
      'address-form': submitAddress,
    };
    const form = event.target;
    const handler = handlers[form.id];
    if (!handler) return;
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    const errorElement = form.querySelector('[role="alert"]');
    if (errorElement) errorElement.textContent = '';
    try {
      await handler(form);
    } catch (error) {
      if (errorElement) errorElement.textContent = error.message;
      else showToast(error.message || 'تعذر إكمال العملية.');
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  /** Escape يغلق المقاسات ويعيد التركيز لزر الفتح. */
  function handleKeydown(event) {
    const options = select('#size-options');
    if (event.key === 'Escape' && options && !options.hidden) {
      toggleSizes(false);
      select('#size-button').focus();
    }
  }
  document.addEventListener('click', (event) => {
    Promise.resolve(handleClick(event)).catch((error) =>
      showToast(error.message || 'تعذر إكمال العملية.'),
    );
  });
  document.addEventListener('input', handleInput);
  document.addEventListener('change', handleChange);
  document.addEventListener('submit', handleSubmit);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('hashchange', () => renderPage());

  // defer في HTML يضمن توفر القوالب قبل تشغيل هذه الخطوات.
  async function loadPageData(route) {
    if (['home', 'products', 'product', 'cart', 'checkout', 'favorites'].includes(route.name)) {
      const result = await api.products();
      PRODUCTS = result.products;
      state.cart = state.cart
        .filter((item) => findProduct(item.id))
        .map((item) => ({
          ...item,
          price: findProduct(item.id).price,
        }));
      writeStorage('cart', state.cart);
    }
    const protectedPages = [
      'orders',
      'tracking',
      'invoice',
      'checkout',
      'favorites',
      'profile',
      'addresses',
    ];
    if (protectedPages.includes(route.name) && !state.profile) {
      returnAfterLogin = `${route.name}${route.id ? '/' + route.id : ''}`;
      navigate('login');
      return false;
    }
    if (state.profile && ['orders', 'success'].includes(route.name)) {
      state.orders = (await api.orders()).orders;
    }
    if (state.profile && ['tracking', 'invoice'].includes(route.name)) {
      const order = (await api.order(route.id)).order;
      state.orders = [order, ...state.orders.filter((entry) => entry.id !== order.id)];
    }
    if (state.profile && ['favorites', 'product'].includes(route.name)) {
      state.favorites = (await api.favorites()).favorites;
    }
    if (state.profile && route.name === 'addresses')
      state.addresses = (await api.addresses()).addresses;
    return true;
  }

  async function logoutCustomer() {
    await api.logout();
    state.profile = null;
    state.orders = [];
    state.favorites = [];
    navigate('account');
    showToast('تم تسجيل الخروج. يمكنك الدخول لاحقًا بالحساب نفسه.');
  }

  function renderForgotPassword() {
    app.append(cloneTemplate('forgot-password'));
    const portal = getRoute().id === 'admin' ? 'admin' : 'customer';
    setText('#forgot-portal', portal === 'admin' ? 'استعادة حساب الأدمن' : 'استعادة حساب العميل');
    select('#forgot-back').href = portal === 'admin' ? '/admin.html' : '#login';
  }

  function renderResetPassword() {
    app.append(cloneTemplate('reset-password'));
  }

  async function submitForgotPassword(form) {
    const result = await api.forgot({
      email: new FormData(form).get('email'),
      portal: getRoute().id === 'admin' ? 'admin' : 'customer',
    });
    setText('#forgot-message', result.message);
    form.reset();
  }

  async function submitResetPassword(form) {
    const data = Object.fromEntries(new FormData(form));
    if (data.password !== data.confirm) throw new Error('كلمتا المرور غير متطابقتين.');
    const route = getRoute();
    const result = await api.reset({
      token: route.id,
      portal: route.portal,
      password: data.password,
    });
    form.reset();
    setText('#reset-message', result.message);
    select('#reset-submit').hidden = true;
    select('#reset-login').hidden = false;
    select('#reset-login').href = route.portal === 'admin' ? '/admin.html' : '#login';
  }

  function renderAddresses() {
    appendHeading('عناوين الشحن', 'account');
    app.append(cloneTemplate('addresses'));
    for (const address of state.addresses) {
      const fragment = cloneTemplate('address-item');
      binding(fragment, 'label').textContent = address.label;
      binding(fragment, 'address').textContent = [
        address.city,
        address.district,
        address.street,
      ].join('، ');
      binding(fragment, 'remove').dataset.removeAddress = address.id;
      select('#saved-addresses').append(fragment);
    }
  }

  async function submitAddress(form) {
    await api.addAddress(Object.fromEntries(new FormData(form)));
    await renderPage();
    showToast('حُفظ العنوان.');
  }

  async function removeAddress(id) {
    await api.deleteAddress(id);
    await renderPage();
    showToast('حُذف العنوان.');
  }

  async function bootstrap() {
    hydrateIcons();
    app.replaceChildren(cloneTemplate('loading'));
    try {
      const [catalog, session] = await Promise.all([api.products(), api.session()]);
      PRODUCTS = catalog.products;
      state.profile = session.user;
      if (state.profile) state.favorites = (await api.favorites()).favorites;
      await renderPage();
    } catch (error) {
      app.replaceChildren();
      appendEmpty(
        'الخادم غير متصل',
        'إعادة المحاولة',
        'home',
        'شغّل npm start بعد إعداد .env وMySQL. لا تُستخدم بيانات حسابات محلية بديلة.',
      );
    }
  }

  async function refreshCatalog() {
    if (document.hidden || !['home', 'products', 'favorites', 'product'].includes(getRoute().name))
      return;
    try {
      const result = await api.products();
      if (JSON.stringify(result.products) === JSON.stringify(PRODUCTS)) return;
      if (
        getRoute().name === 'product' &&
        ['INPUT', 'SELECT'].includes(document.activeElement.tagName)
      )
        return;
      PRODUCTS = result.products;
      if (getRoute().name === 'home') renderHomeProducts();
      else if (['products', 'favorites'].includes(getRoute().name)) updateCatalogResults();
      else if (!['INPUT', 'SELECT'].includes(document.activeElement.tagName)) {
        await renderPage({ preserveScroll: true });
      }
    } catch {
      /* إعادة المحاولة في الدورة التالية؛ لا نستبدل البيانات بنسخة وهمية. */
    }
  }

  setInterval(refreshCatalog, 10000);
  window.addEventListener('focus', refreshCatalog);
  bootstrap();
})();
