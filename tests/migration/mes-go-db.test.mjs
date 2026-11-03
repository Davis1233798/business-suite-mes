import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../scripts/migrate-mes-go-db.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const migrations = path.join(root, 'backend', 'migrations');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-go-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeSource(file, { badReporter = false, pendingOutbox = false } = {}) {
  const db = new DatabaseSync(file);
  for (const name of ['mes_initial.sql', 'mes_guards.sql', '0004_station_identity.sql', '0005_traffic_lab.sql']) {
    db.exec(fs.readFileSync(path.join(migrations, name), 'utf8'));
  }
  db.exec(`CREATE TABLE suite_migrations(name TEXT PRIMARY KEY);
    CREATE TABLE mes_projection_revisions(organization_id TEXT NOT NULL,work_order_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(organization_id,work_order_id));
    CREATE TABLE mes_repository_schema(version INTEGER NOT NULL);
    INSERT INTO mes_repository_schema VALUES(1);
    CREATE TABLE erp_test_rows(id TEXT PRIMARY KEY, organization_id TEXT);
    INSERT INTO erp_test_rows VALUES('erp-row','tenant-a');`);
  db.prepare('INSERT INTO organizations(id,name,slug) VALUES(?,?,?)').run('tenant-a', 'Tenant A', 'tenant-a');
  db.prepare('INSERT INTO organizations(id,name,slug) VALUES(?,?,?)').run('tenant-b', 'Tenant B', 'tenant-b');
  db.prepare('INSERT INTO users(id,email,display_name) VALUES(?,?,?)').run('user-a', 'a@example.test', 'User A');
  db.prepare('INSERT INTO users(id,email,display_name) VALUES(?,?,?)').run('user-b', 'b@example.test', 'User B');
  db.prepare('INSERT INTO memberships(id,organization_id,user_id) VALUES(?,?,?)').run('member-a', 'tenant-a', 'user-a');
  db.prepare('INSERT INTO memberships(id,organization_id,user_id) VALUES(?,?,?)').run('member-b', 'tenant-b', 'user-b');
  db.prepare('INSERT INTO station_accounts(user_id,organization_id,email,password_hash) VALUES(?,?,?,?)').run('user-a', 'tenant-a', 'a@example.test', 'pbkdf2-sha256$test$hash');
  db.prepare('INSERT INTO station_grants(user_id,site,role,scope) VALUES(?,?,?,?)').run('user-a', 'mes', 'admin', 'back');
  db.prepare('INSERT INTO station_grants(user_id,site,role,scope) VALUES(?,?,?,?)').run('user-a', 'erp', 'admin', 'back');
  db.prepare('INSERT INTO station_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run('secret-session-hash', 'user-a', 9999999999999);
  db.prepare('INSERT INTO mes_products(id,organization_id,sku,name) VALUES(?,?,?,?)').run('product-a', 'tenant-a', 'SKU-A', 'Product A');
  db.prepare('INSERT INTO mes_bom_versions(id,organization_id,product_id) VALUES(?,?,?)').run('bom-a', 'tenant-a', 'product-a');
  db.prepare('INSERT INTO mes_work_centers(id,organization_id,code,name) VALUES(?,?,?,?)').run('center-a', 'tenant-a', 'C-A', 'Center A');
  db.prepare('INSERT INTO mes_work_orders(id,organization_id,order_no,product_id,bom_version_id,target_quantity) VALUES(?,?,?,?,?,?)').run('wo-a', 'tenant-a', 'WO-A', 'product-a', 'bom-a', 10);
  db.prepare('INSERT INTO mes_operations(id,organization_id,work_order_id,sequence,work_center_id,name) VALUES(?,?,?,?,?,?)').run('op-a', 'tenant-a', 'wo-a', 1, 'center-a', 'Cut');
  db.prepare('INSERT INTO mes_production_reports(id,organization_id,work_order_id,operation_id,operator_id,good_quantity,scrap_quantity) VALUES(?,?,?,?,?,?,?)').run('report-a', 'tenant-a', 'wo-a', 'op-a', 'user-a', 2, 0);
  db.prepare('INSERT INTO audit_events(id,organization_id,actor_id,actor_role,action,entity_type,entity_id) VALUES(?,?,?,?,?,?,?)').run('audit-a', 'tenant-a', 'user-a', 'admin', 'mes.report', 'work_order', 'wo-a');
  db.prepare('INSERT INTO audit_events(id,organization_id,actor_id,actor_role,action,entity_type,entity_id) VALUES(?,?,?,?,?,?,?)').run('audit-erp', 'tenant-a', 'user-a', 'admin', 'STATION_GRANT', 'ACCOUNT', 'user-a');
  if (badReporter) db.prepare('INSERT INTO mes_downtime_events(id,organization_id,work_center_id,start_time,reason,reporter_id) VALUES(?,?,?,?,?,?)').run('down-a', 'tenant-a', 'center-a', '2026-01-01T00:00:00Z', 'test', 'missing-user');
  if (pendingOutbox) db.prepare('INSERT INTO outbox_events(id,organization_id,event_type,payload) VALUES(?,?,?,?)').run('event-a', 'tenant-a', 'mes.work-order.changed', '{}');
  db.close();
}

function addForeignMembership(file) {
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO memberships(id,organization_id,user_id) VALUES(?,?,?)').run('member-a-other', 'tenant-b', 'user-a');
  db.close();
}

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('imports only selected MES tenant, preserves required identities and audit, resets delivery/session state', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSource(source);
  const before = sha256(source);
  const result = migrate(source, destination, ['tenant-a']);
  assert.equal(sha256(source), before);
  assert.deepEqual(result.organizationIds, ['tenant-a']);
  const db = new DatabaseSync(destination, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n, 1);
  assert.equal(db.prepare('SELECT id FROM organizations').get().id, 'tenant-a');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mes_work_orders WHERE organization_id="tenant-a"').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(db.prepare('SELECT password_hash FROM station_accounts WHERE user_id="user-a"').get().password_hash, 'pbkdf2-sha256$test$hash');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM station_grants WHERE site='erp'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM station_sessions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM erp_test_rows').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE event_type LIKE 'mes.%'").get().n, 1, 'target projection is rebuilt from work orders');
  assert.equal(db.prepare('SELECT version FROM mes_repository_schema').get().version, 1);
  db.close();
});

test('refuses existing destination without changing source or destination', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSource(source); fs.writeFileSync(destination, 'preserve me');
  const beforeSource = sha256(source), beforeDestination = sha256(destination);
  assert.throws(() => migrate(source, destination, ['tenant-a']));
  assert.equal(sha256(source), beforeSource);
  assert.equal(sha256(destination), beforeDestination);
});

test('fails closed on unresolved MES references and removes partial output', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSource(source, { badReporter: true });
  assert.throws(() => migrate(source, destination, ['tenant-a']), /unresolved/);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readdirSync(dir).some(name => name.includes('.mes-target-') || name.includes('.mes-source-')), false);
});

test('blocks a source with unresolved MES outbox rows', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSource(source, { pendingOutbox: true });
  assert.throws(() => migrate(source, destination, ['tenant-a']), /outbox contains/);
  assert.equal(fs.existsSync(destination), false);
});

test('refuses a retained identity that also belongs to an unselected tenant', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSource(source); addForeignMembership(source);
  assert.throws(() => migrate(source, destination, ['tenant-a']), /unselected tenant/);
  assert.equal(fs.existsSync(destination), false);
});

test('refuses an unsupported source marker before creating any output', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSource(source);
  const db = new DatabaseSync(source);
  db.prepare('UPDATE mes_repository_schema SET version=9').run(); db.close();
  assert.throws(() => migrate(source, destination, ['tenant-a']), /Unsupported or unmarked/);
  assert.equal(fs.existsSync(destination), false);
});
