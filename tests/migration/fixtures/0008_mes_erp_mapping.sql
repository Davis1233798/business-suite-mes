CREATE TABLE IF NOT EXISTS mes_erp_product_mappings (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  mes_product_id TEXT NOT NULL,
  erp_item_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  is_active INTEGER NOT NULL CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, mes_product_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS mes_erp_one_active_mapping
  ON mes_erp_product_mappings(organization_id, mes_product_id) WHERE is_active=1;
