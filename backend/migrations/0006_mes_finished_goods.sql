-- MES finished goods are an additive, traceable ledger. Existing work orders,
-- reports, quality samples, and backup rows remain untouched; in particular,
-- no historical completed order is implicitly released or received.
CREATE TABLE IF NOT EXISTS mes_finished_goods_batches (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  work_order_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  batch_number TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'pending_inspection'
    CHECK (status IN ('pending_inspection','quarantined','released','received','rework','scrapped')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, batch_number),
  UNIQUE (organization_id, id),
  FOREIGN KEY (work_order_id) REFERENCES mes_work_orders(id),
  FOREIGN KEY (report_id) REFERENCES mes_production_reports(id)
);

CREATE INDEX IF NOT EXISTS mes_finished_goods_batches_work_order_idx
  ON mes_finished_goods_batches(organization_id, work_order_id, created_at);

-- A report and its order must be from the same tenant and the report must
-- actually belong to the referenced order. FKs alone cannot enforce tenant
-- equality because the legacy parent tables do not have composite unique keys.
CREATE TRIGGER IF NOT EXISTS mes_finished_goods_batch_trace_insert
BEFORE INSERT ON mes_finished_goods_batches
WHEN NOT EXISTS (
  SELECT 1 FROM mes_work_orders w
  JOIN mes_production_reports r
    ON r.organization_id=w.organization_id AND r.work_order_id=w.id
  WHERE w.organization_id=NEW.organization_id
    AND w.id=NEW.work_order_id AND r.id=NEW.report_id
) OR NEW.quantity + COALESCE((
  SELECT SUM(b.quantity) FROM mes_finished_goods_batches b
  WHERE b.organization_id=NEW.organization_id AND b.report_id=NEW.report_id
), 0) > COALESCE((
  SELECT r.good_quantity FROM mes_production_reports r
  WHERE r.organization_id=NEW.organization_id AND r.id=NEW.report_id
), 0)
BEGIN
  SELECT RAISE(ABORT, 'Finished goods batch must trace to a report and work order in the same organization');
END;

CREATE TRIGGER IF NOT EXISTS mes_finished_goods_batch_trace_update
BEFORE UPDATE OF organization_id,work_order_id,report_id ON mes_finished_goods_batches
WHEN NOT EXISTS (
  SELECT 1 FROM mes_work_orders w
  JOIN mes_production_reports r
    ON r.organization_id=w.organization_id AND r.work_order_id=w.id
  WHERE w.organization_id=NEW.organization_id
    AND w.id=NEW.work_order_id AND r.id=NEW.report_id
) OR NEW.quantity + COALESCE((
  SELECT SUM(b.quantity) FROM mes_finished_goods_batches b
  WHERE b.organization_id=NEW.organization_id AND b.report_id=NEW.report_id AND b.id<>NEW.id
), 0) > COALESCE((
  SELECT r.good_quantity FROM mes_production_reports r
  WHERE r.organization_id=NEW.organization_id AND r.id=NEW.report_id
), 0)
BEGIN
  SELECT RAISE(ABORT, 'Finished goods batch must trace to a report and work order in the same organization');
END;

CREATE TABLE IF NOT EXISTS mes_finished_goods_quality_dispositions (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  passed_quantity INTEGER NOT NULL CHECK (passed_quantity >= 0),
  failed_quantity INTEGER NOT NULL CHECK (failed_quantity >= 0),
  disposition TEXT NOT NULL CHECK (disposition IN ('release','quarantine','rework','scrap')),
  quality_check_id TEXT,
  reinspection_after INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (passed_quantity + failed_quantity > 0),
  CHECK (disposition <> 'release' OR failed_quantity = 0),
  UNIQUE (organization_id, id),
  FOREIGN KEY (batch_id) REFERENCES mes_finished_goods_batches(id)
);

CREATE INDEX IF NOT EXISTS mes_finished_goods_quality_batch_idx
  ON mes_finished_goods_quality_dispositions(organization_id, batch_id, created_at);

CREATE TRIGGER IF NOT EXISTS mes_finished_goods_quality_batch_insert
BEFORE INSERT ON mes_finished_goods_quality_dispositions
WHEN NOT EXISTS (
  SELECT 1 FROM mes_finished_goods_batches b
  WHERE b.organization_id=NEW.organization_id AND b.id=NEW.batch_id
    AND NEW.passed_quantity + NEW.failed_quantity <= b.quantity
)
BEGIN
  SELECT RAISE(ABORT, 'Quality disposition must match a batch in the same organization and stay within its quantity');
END;

CREATE TABLE IF NOT EXISTS mes_finished_goods_inventory (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, batch_id),
  FOREIGN KEY (batch_id) REFERENCES mes_finished_goods_batches(id)
);

CREATE TABLE IF NOT EXISTS mes_finished_goods_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (batch_id) REFERENCES mes_finished_goods_batches(id)
);

CREATE INDEX IF NOT EXISTS mes_finished_goods_receipts_batch_idx
  ON mes_finished_goods_receipts(organization_id, batch_id, created_at);

CREATE TRIGGER IF NOT EXISTS mes_finished_goods_receipt_batch_insert
BEFORE INSERT ON mes_finished_goods_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM mes_finished_goods_batches b
  WHERE b.organization_id=NEW.organization_id AND b.id=NEW.batch_id
)
BEGIN
  SELECT RAISE(ABORT, 'Finished goods receipt batch is outside the organization');
END;

CREATE TRIGGER IF NOT EXISTS mes_finished_goods_inventory_batch_insert
BEFORE INSERT ON mes_finished_goods_inventory
WHEN NOT EXISTS (
  SELECT 1 FROM mes_finished_goods_batches b
  WHERE b.organization_id=NEW.organization_id AND b.id=NEW.batch_id
)
BEGIN
  SELECT RAISE(ABORT, 'Finished goods inventory batch is outside the organization');
END;

INSERT OR IGNORE INTO suite_migrations(name) VALUES ('0006_mes_finished_goods');
