-- Run once as the warehouse owner (the schema is the user).
-- Requires Oracle 12c or newer for OFFSET / FETCH FIRST pagination.

CREATE TABLE customers (
  id         NUMBER(19) PRIMARY KEY,
  tenant_id  VARCHAR2(64) NOT NULL,
  name       VARCHAR2(200) NOT NULL,
  email      VARCHAR2(320) NOT NULL,
  phone      VARCHAR2(40),
  region     VARCHAR2(64),
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE products (
  id          NUMBER(19) PRIMARY KEY,
  tenant_id   VARCHAR2(64) NOT NULL,
  name        VARCHAR2(200) NOT NULL,
  category    VARCHAR2(64) NOT NULL,
  price_cents NUMBER(19) NOT NULL
);

CREATE TABLE orders (
  id          NUMBER(19) PRIMARY KEY,
  tenant_id   VARCHAR2(64) NOT NULL,
  customer_id NUMBER(19) NOT NULL REFERENCES customers(id),
  status      VARCHAR2(32) NOT NULL,
  total_cents NUMBER(19) NOT NULL,
  currency    CHAR(3) NOT NULL,
  ordered_at  TIMESTAMP NOT NULL
);

CREATE TABLE order_items (
  id               NUMBER(19) PRIMARY KEY,
  order_id         NUMBER(19) NOT NULL REFERENCES orders(id),
  product_id       NUMBER(19) NOT NULL REFERENCES products(id),
  quantity         NUMBER(10) NOT NULL,
  unit_price_cents NUMBER(19) NOT NULL
);

CREATE INDEX orders_tenant_time_idx ON orders (tenant_id, ordered_at DESC, id DESC);
CREATE INDEX order_items_order_idx ON order_items (order_id);
