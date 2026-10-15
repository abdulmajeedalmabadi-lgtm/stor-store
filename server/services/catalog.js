/** المصدر الوحيد للكتالوج هو MySQL؛ العميل يعيد قراءته دون بيانات منتجات ثابتة. */
import { rows } from '../db.js';

export async function getProducts({ includeInactive = false } = {}, connection) {
  const products = await rows(
    `SELECT p.*,c.code AS category FROM products p
    JOIN categories c ON c.id=p.category_id ${includeInactive ? '' : 'WHERE p.is_active=TRUE'} ORDER BY p.id`,
    [],
    connection,
  );
  if (!products.length) return [];
  const images = await rows(
    'SELECT * FROM product_images ORDER BY product_id,sort_order',
    [],
    connection,
  );
  const sizes = await rows(
    `SELECT ps.product_id,s.code,ps.stock_quantity FROM product_sizes ps
    JOIN sizes s ON s.id=ps.size_id ORDER BY ps.product_id,s.sort_order`,
    [],
    connection,
  );
  return products.map((product) => {
    const stock = sizes
      .filter((size) => String(size.product_id) === String(product.id))
      .map((size) => ({ code: size.code, stock: size.stock_quantity }));
    const productImages = images
      .filter((image) => String(image.product_id) === String(product.id))
      .map((image) => ({ path: image.image_path, alt: image.alt_text }));
    return {
      id: Number(product.id),
      sku: product.sku,
      name: product.name,
      description: product.description,
      price: Number(product.price),
      tag: product.tag,
      fit: product.fit,
      category: product.category,
      color: product.default_color,
      active: Boolean(product.is_active),
      version: product.version,
      available: stock.some((size) => size.stock > 0),
      images: productImages,
      sizes: stock,
      updatedAt: product.updated_at,
    };
  });
}
