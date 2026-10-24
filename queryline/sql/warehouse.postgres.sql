CREATE SCHEMA IF NOT EXISTS warehouse;

CREATE TABLE IF NOT EXISTS warehouse.customers (
  id         bigint PRIMARY KEY,
  tenant_id  text NOT NULL,
  name       text NOT NULL,
  email      text NOT NULL,
  phone      text,
  region     text,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouse.products (
  id          bigint PRIMARY KEY,
  tenant_id   text NOT NULL,
  name        text NOT NULL,
  category    text NOT NULL,
  price_cents bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouse.orders (
  id          bigint PRIMARY KEY,
  tenant_id   text NOT NULL,
  customer_id bigint NOT NULL REFERENCES warehouse.customers(id),
  status      text NOT NULL,
  total_cents bigint NOT NULL,
  currency    char(3) NOT NULL,
  ordered_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouse.order_items (
  id               bigint PRIMARY KEY,
  order_id         bigint NOT NULL REFERENCES warehouse.orders(id),
  product_id       bigint NOT NULL REFERENCES warehouse.products(id),
  quantity         integer NOT NULL,
  unit_price_cents bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS orders_tenant_time_idx
  ON warehouse.orders (tenant_id, ordered_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON warehouse.order_items (order_id);
