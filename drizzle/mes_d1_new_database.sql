CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_role` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before_value` text,
	`after_value` text,
	`reason` text,
	`request_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`key` text NOT NULL,
	`endpoint` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'operator' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mes_bom_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`bom_version_id` text NOT NULL,
	`material_sku` text NOT NULL,
	`material_name` text NOT NULL,
	`quantity_per_unit` integer NOT NULL,
	`unit` text DEFAULT 'PCS' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mes_bom_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mes_downtime_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`work_center_id` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text,
	`duration_minutes` integer DEFAULT 0,
	`reason` text NOT NULL,
	`reporter_id` text NOT NULL,
	`status` text DEFAULT 'ongoing' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mes_material_lots` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`lot_number` text NOT NULL,
	`material_sku` text NOT NULL,
	`initial_quantity` integer NOT NULL,
	`current_quantity` integer NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mes_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`work_order_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`work_center_id` text NOT NULL,
	`name` text NOT NULL,
	`standard_minutes_per_unit` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mes_production_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`work_order_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`operator_id` text NOT NULL,
	`good_quantity` integer NOT NULL,
	`scrap_quantity` integer NOT NULL,
	`report_time` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`notes` text,
	`idempotency_key` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mes_products` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`unit` text DEFAULT 'PCS' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mes_quality_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`work_order_id` text NOT NULL,
	`report_id` text,
	`inspector_id` text NOT NULL,
	`sample_quantity` integer NOT NULL,
	`passed_quantity` integer NOT NULL,
	`failed_quantity` integer NOT NULL,
	`status` text DEFAULT 'passed' NOT NULL,
	`disposition` text,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mes_work_centers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`capacity_minutes_per_day` integer DEFAULT 480 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mes_work_order_materials` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`work_order_id` text NOT NULL,
	`material_lot_id` text NOT NULL,
	`material_sku` text NOT NULL,
	`issued_quantity` integer NOT NULL,
	`returned_quantity` integer DEFAULT 0 NOT NULL,
	`net_quantity` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mes_work_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`order_no` text NOT NULL,
	`product_id` text NOT NULL,
	`bom_version_id` text NOT NULL,
	`target_quantity` integer NOT NULL,
	`completed_quantity` integer DEFAULT 0 NOT NULL,
	`scrapped_quantity` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`materials_staged` integer DEFAULT false NOT NULL,
	`scheduled_minutes` integer DEFAULT 480 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);
--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_scope_unique ON idempotency_keys(organization_id, key, endpoint);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS mes_report_limit BEFORE UPDATE OF completed_quantity, scrapped_quantity ON mes_work_orders WHEN NEW.completed_quantity < 0 OR NEW.scrapped_quantity < 0 OR NEW.completed_quantity + NEW.scrapped_quantity > NEW.target_quantity OR OLD.status != 'in_progress' BEGIN SELECT RAISE(ABORT, 'Work order is closed or production exceeds target'); END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS demo_seed_states (organization_id TEXT PRIMARY KEY NOT NULL, ready_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

-- MES PostgreSQL projection: revision metadata is not restorable business data.
CREATE TABLE IF NOT EXISTS suite_migrations (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS mes_projection_revisions (
  organization_id TEXT NOT NULL,
  work_order_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (organization_id, work_order_id)
);
CREATE INDEX IF NOT EXISTS outbox_pending_dispatch_idx ON outbox_events(event_type,status,created_at,id);

CREATE TRIGGER IF NOT EXISTS mes_work_orders_projection_insert
AFTER INSERT ON mes_work_orders
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (NEW.organization_id, NEW.id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), NEW.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', NEW.id));
END;

CREATE TRIGGER IF NOT EXISTS mes_work_orders_projection_update
AFTER UPDATE ON mes_work_orders
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (NEW.organization_id, NEW.id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), NEW.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', NEW.id));
END;

CREATE TRIGGER IF NOT EXISTS mes_work_orders_projection_delete
AFTER DELETE ON mes_work_orders
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (OLD.organization_id, OLD.id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), OLD.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', OLD.id));
END;

CREATE TRIGGER IF NOT EXISTS mes_operations_projection_insert
AFTER INSERT ON mes_operations
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (NEW.organization_id, NEW.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), NEW.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', NEW.work_order_id));
END;

CREATE TRIGGER IF NOT EXISTS mes_operations_projection_update
AFTER UPDATE ON mes_operations
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (NEW.organization_id, NEW.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), NEW.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', NEW.work_order_id));
END;

CREATE TRIGGER IF NOT EXISTS mes_operations_projection_delete
AFTER DELETE ON mes_operations
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (OLD.organization_id, OLD.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), OLD.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', OLD.work_order_id));
END;

CREATE TRIGGER IF NOT EXISTS mes_work_order_materials_projection_insert
AFTER INSERT ON mes_work_order_materials
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (NEW.organization_id, NEW.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), NEW.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', NEW.work_order_id));
END;

CREATE TRIGGER IF NOT EXISTS mes_work_order_materials_projection_update
AFTER UPDATE ON mes_work_order_materials
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (NEW.organization_id, NEW.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), NEW.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', NEW.work_order_id));
END;

CREATE TRIGGER IF NOT EXISTS mes_work_order_materials_projection_delete
AFTER DELETE ON mes_work_order_materials
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (OLD.organization_id, OLD.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), OLD.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', OLD.work_order_id));
END;

CREATE TRIGGER IF NOT EXISTS mes_production_reports_projection_insert
AFTER INSERT ON mes_production_reports
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (NEW.organization_id, NEW.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), NEW.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', NEW.work_order_id));
END;

CREATE TRIGGER IF NOT EXISTS mes_production_reports_projection_update
AFTER UPDATE ON mes_production_reports
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (NEW.organization_id, NEW.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), NEW.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', NEW.work_order_id));
END;

CREATE TRIGGER IF NOT EXISTS mes_production_reports_projection_delete
AFTER DELETE ON mes_production_reports
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (OLD.organization_id, OLD.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), OLD.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', OLD.work_order_id));
END;

CREATE TRIGGER IF NOT EXISTS mes_quality_checks_projection_insert
AFTER INSERT ON mes_quality_checks
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (NEW.organization_id, NEW.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), NEW.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', NEW.work_order_id));
END;

CREATE TRIGGER IF NOT EXISTS mes_quality_checks_projection_update
AFTER UPDATE ON mes_quality_checks
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (NEW.organization_id, NEW.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), NEW.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', NEW.work_order_id));
END;

CREATE TRIGGER IF NOT EXISTS mes_quality_checks_projection_delete
AFTER DELETE ON mes_quality_checks
BEGIN
  INSERT INTO mes_projection_revisions(organization_id, work_order_id, revision)
    VALUES (OLD.organization_id, OLD.work_order_id, 1)
    ON CONFLICT(organization_id, work_order_id) DO UPDATE SET revision=revision+1;
  INSERT INTO outbox_events(id, organization_id, event_type, payload)
    VALUES ('mes:' || lower(hex(randomblob(16))), OLD.organization_id, 'mes.work-order.changed',
      json_object('workOrderId', OLD.work_order_id));
END;

-- Initial backfill is queued exactly once; ordinary writes use the triggers.
INSERT OR IGNORE INTO mes_projection_revisions(organization_id,work_order_id,revision)
  SELECT organization_id,id,1 FROM mes_work_orders
  WHERE NOT EXISTS(SELECT 1 FROM suite_migrations WHERE name='0003_mes_projection');
INSERT OR IGNORE INTO outbox_events(id,organization_id,event_type,payload)
  SELECT 'mes.backfill:' || organization_id || ':' || id, organization_id,
    'mes.work-order.changed', json_object('workOrderId',id)
  FROM mes_work_orders
  WHERE NOT EXISTS(SELECT 1 FROM suite_migrations WHERE name='0003_mes_projection');
INSERT OR IGNORE INTO suite_migrations(name) VALUES ('0003_mes_projection');

CREATE TABLE mes_vinext_schema(version INTEGER NOT NULL); INSERT INTO mes_vinext_schema VALUES (1);
