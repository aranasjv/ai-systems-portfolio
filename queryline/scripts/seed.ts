import { loadConfig } from '../src/config.js';
import { createWarehouseAdapter } from '../src/warehouse/index.js';

const TENANT = 'demo-tenant';
const OTHER_TENANT = 'other-tenant';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = mulberry32(42);

function pick<T>(items: T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function int(min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function literal(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function insertSql(table: string, columns: string[], rows: (string | number | null)[][]): string {
  const values = rows
    .map((row) => `(${row.map((value) => literal(value)).join(', ')})`)
    .join(',\n');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${values}`;
}

function timestamp(daysAgo: number, hour: number): string {
  const date = new Date(Date.UTC(2025, 0, 1, hour, 0, 0));
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

interface Customer {
  id: number;
  tenant: string;
  name: string;
  email: string;
  phone: string | null;
  region: string | null;
}

interface Product {
  id: number;
  name: string;
  category: string;
  priceCents: number;
}

interface Order {
  id: number;
  tenant: string;
  customerId: number;
  status: string;
  totalCents: number;
  orderedAt: string;
}

interface OrderItem {
  id: number;
  orderId: number;
  productId: number;
  quantity: number;
  unitPriceCents: number;
}

function buildData() {
  const regions = ['emea', 'amer', 'apac', null];
  const statuses = ['paid', 'paid', 'paid', 'pending', 'shipped', 'delivered', 'refunded', 'cancelled'];
  const categories = ['hardware', 'software', 'services', 'accessories'];

  const customers: Customer[] = [];
  for (let id = 1; id <= 40; id += 1) {
    const tenant = id <= 32 ? TENANT : OTHER_TENANT;
    customers.push({
      id,
      tenant,
      name: `Customer ${id}`,
      email: `customer${id}@example.com`,
      phone: id % 3 === 0 ? null : `+1-555-${String(1000 + id)}`,
      region: pick(regions),
    });
  }

  const products: Product[] = [];
  for (let id = 1; id <= 20; id += 1) {
    products.push({
      id,
      name: `Product ${id}`,
      category: categories[id % categories.length]!,
      priceCents: int(5, 400) * 100,
    });
  }

  const orderItems: OrderItem[] = [];
  const orders: Order[] = [];
  let itemId = 1;

  for (let id = 1; id <= 120; id += 1) {
    const tenant = id <= 100 ? TENANT : OTHER_TENANT;
    const customerPool = customers.filter((customer) => customer.tenant === tenant);
    const customer = pick(customerPool);
    const createdAt = timestamp(int(0, 180), int(0, 23));

    let total = 0;
    const lineCount = int(1, 4);
    for (let line = 0; line < lineCount; line += 1) {
      const product = pick(products);
      const quantity = int(1, 3);
      total += product.priceCents * quantity;
      orderItems.push({
        id: itemId,
        orderId: id,
        productId: product.id,
        quantity,
        unitPriceCents: product.priceCents,
      });
      itemId += 1;
    }

    orders.push({
      id,
      tenant,
      customerId: customer.id,
      status: pick(statuses),
      totalCents: total,
      orderedAt: createdAt,
    });
  }

  return { customers, products, orders, orderItems };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const adapter = createWarehouseAdapter(config.warehouse);
  await adapter.connect();

  // Oracle uses the connecting user as the schema, so its tables are unqualified.
  const prefix =
    config.warehouse.kind === 'oracle' ? '' : `${config.warehouse.schema ?? 'warehouse'}.`;
  const table = (name: string): string => `${prefix}${name}`;

  try {
    const data = buildData();

    const batchSize = 40;
    for (let index = 0; index < data.customers.length; index += batchSize) {
      await adapter.admin().exec(
        insertSql(
          table('customers'),
          ['id', 'tenant_id', 'name', 'email', 'phone', 'region', 'created_at'],
          data.customers
            .slice(index, index + batchSize)
            .map((customer) => [
              customer.id,
              customer.tenant,
              customer.name,
              customer.email,
              customer.phone,
              customer.region,
              timestamp(200 - customer.id, 9),
            ]),
        ),
      );
    }

    await adapter.admin().exec(
      insertSql(
        table('products'),
        ['id', 'tenant_id', 'name', 'category', 'price_cents'],
        data.products.map((product) => [
          product.id,
          TENANT,
          product.name,
          product.category,
          product.priceCents,
        ]),
      ),
    );

    for (let index = 0; index < data.orders.length; index += batchSize) {
      await adapter.admin().exec(
        insertSql(
          table('orders'),
          ['id', 'tenant_id', 'customer_id', 'status', 'total_cents', 'currency', 'ordered_at'],
          data.orders
            .slice(index, index + batchSize)
            .map((order) => [
              order.id,
              order.tenant,
              order.customerId,
              order.status,
              order.totalCents,
              'USD',
              order.orderedAt,
            ]),
        ),
      );
    }

    for (let index = 0; index < data.orderItems.length; index += 60) {
      await adapter.admin().exec(
        insertSql(
          table('order_items'),
          ['id', 'order_id', 'product_id', 'quantity', 'unit_price_cents'],
          data.orderItems
            .slice(index, index + 60)
            .map((item) => [
              item.id,
              item.orderId,
              item.productId,
              item.quantity,
              item.unitPriceCents,
            ]),
        ),
      );
    }

    console.log(
      `seeded ${data.customers.length} customers, ${data.products.length} products, ${data.orders.length} orders, ${data.orderItems.length} order items`,
    );
  } finally {
    await adapter.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
