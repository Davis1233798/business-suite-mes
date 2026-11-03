CREATE TABLE IF NOT EXISTS erp_mes_receipt_postings (
 id TEXT PRIMARY KEY NOT NULL,
 organization_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 source_receipt_id TEXT NOT NULL,
 mapping_id TEXT NOT NULL,
 mapping_version INTEGER NOT NULL,
 item_id TEXT NOT NULL,
 warehouse_id TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity > 0),
 unit_cost INTEGER NOT NULL CHECK(unit_cost >= 0),
 reason TEXT NOT NULL,
 ledger_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(organization_id,event_id),
 UNIQUE(organization_id,source_receipt_id)
);
