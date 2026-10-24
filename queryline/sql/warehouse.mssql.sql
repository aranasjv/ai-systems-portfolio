IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'warehouse')
  EXEC('CREATE SCHEMA warehouse');

IF OBJECT_ID('warehouse.customers', 'U') IS NULL
CREATE TABLE warehouse.customers (
  id         bigint NOT NULL PRIMARY KEY,
  tenant_id  nvarchar(64) NOT NULL,
  name       nvarchar(200) NOT NULL,
  email      nvarchar(320) NOT NULL,
  phone      nvarchar(40) NULL,
  region     nvarchar(64) NULL,
  created_at datetime2 NOT NULL
);

IF OBJECT_ID('warehouse.products', 'U') IS NULL
CREATE TABLE warehouse.products (
  id          bigint NOT NULL PRIMARY KEY,
  tenant_id   nvarchar(64) NOT NULL,
  name        nvarchar(200) NOT NULL,
  category    nvarchar(64) NOT NULL,
  price_cents bigint NOT NULL
);

IF OBJECT_ID('warehouse.orders', 'U') IS NULL
CREATE TABLE warehouse.orders (
  id          bigint NOT NULL PRIMARY KEY,
  tenant_id   nvarchar(64) NOT NULL,
  customer_id bigint NOT NULL REFERENCES warehouse.customers(id),
  status      nvarchar(32) NOT NULL,
  total_cents bigint NOT NULL,
  currency    char(3) NOT NULL,
  ordered_at  datetime2 NOT NULL
);

IF OBJECT_ID('warehouse.order_items', 'U') IS NULL
CREATE TABLE warehouse.order_items (
  id               bigint NOT NULL PRIMARY KEY,
  order_id         bigint NOT NULL REFERENCES warehouse.orders(id),
  product_id       bigint NOT NULL REFERENCES warehouse.products(id),
  quantity         integer NOT NULL,
  unit_price_cents bigint NOT NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'orders_tenant_time_idx')
  CREATE INDEX orders_tenant_time_idx ON warehouse.orders (tenant_id, ordered_at DESC, id DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'order_items_order_idx')
  CREATE INDEX order_items_order_idx ON warehouse.order_items (order_id);
