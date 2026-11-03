CREATE TABLE IF NOT EXISTS mes_finished_goods_resolutions (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('rework','scrap')),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  reinspection_after INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(batch_id) REFERENCES mes_finished_goods_batches(id)
);
CREATE TRIGGER IF NOT EXISTS mes_finished_goods_resolution_tenant
BEFORE INSERT ON mes_finished_goods_resolutions
WHEN NOT EXISTS (SELECT 1 FROM mes_finished_goods_batches b WHERE b.id=NEW.batch_id AND b.organization_id=NEW.organization_id AND b.quantity=NEW.quantity)
BEGIN SELECT RAISE(ABORT, 'Invalid finished goods resolution'); END;
INSERT OR IGNORE INTO suite_migrations(name) VALUES ('0007_mes_finished_goods_resolutions');