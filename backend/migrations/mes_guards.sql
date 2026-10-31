CREATE UNIQUE INDEX IF NOT EXISTS idempotency_scope_unique ON idempotency_keys(organization_id, key, endpoint);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS mes_report_limit BEFORE UPDATE OF completed_quantity, scrapped_quantity ON mes_work_orders WHEN NEW.completed_quantity < 0 OR NEW.scrapped_quantity < 0 OR NEW.completed_quantity + NEW.scrapped_quantity > NEW.target_quantity OR OLD.status != 'in_progress' BEGIN SELECT RAISE(ABORT, 'Work order is closed or production exceeds target'); END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS demo_seed_states (organization_id TEXT PRIMARY KEY NOT NULL, ready_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
