import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

function makeSharedSource(file, { badReporter = false, pendingOutbox = false, processedOutbox = false, extraMesTable = false, extraVersion = false, populatedErpMapping = false, tenantBMesGrant = false, retryKey = false, legacyDispositionSchema = false, wal = false } = {}) {
  const db = new DatabaseSync(file);
  // Match the shared Portfolio Go database bootstrap, including its actual
  // common multi-station schema and migration ledger rather than the standalone
  // MES repository's reduced `mes_initial.sql` source.
  for (const name of ['0000_spicy_bromley.sql', '0001_transaction_guards.sql', '0002_dining_takeout.sql', '0003_mes_projection.sql', '0004_station_identity.sql', '0005_traffic_lab.sql', '0006_mes_finished_goods.sql', '0007_mes_finished_goods_resolutions.sql']) {
    db.exec(fs.readFileSync(path.join(migrations, name), 'utf8'));
  }
  for (const name of ['0008_mes_erp_mapping.sql', '0009_erp_mes_receipts.sql']) {
    db.exec(fs.readFileSync(path.join(root, 'tests', 'migration', 'fixtures', name), 'utf8'));
  }
  if (legacyDispositionSchema) db.exec(`DROP TABLE mes_finished_goods_quality_dispositions;
    CREATE TABLE mes_finished_goods_quality_dispositions (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, batch_id TEXT NOT NULL,
      passed_quantity INTEGER NOT NULL, failed_quantity INTEGER NOT NULL, disposition TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
  if (extraVersion) db.prepare('INSERT INTO suite_migrations(name) VALUES(?)').run('0010_mes_unknown');
  if (extraMesTable) db.exec('CREATE TABLE mes_unmapped_feature(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL);');
  db.prepare('INSERT INTO organizations(id,name,slug) VALUES(?,?,?)').run('tenant-a', 'Tenant A', 'tenant-a');
  db.prepare('INSERT INTO organizations(id,name,slug) VALUES(?,?,?)').run('tenant-b', 'Tenant B', 'tenant-b');
  db.prepare('INSERT INTO users(id,email,display_name) VALUES(?,?,?)').run('user-a', 'a@example.test', 'User A');
  db.prepare('INSERT INTO users(id,email,display_name) VALUES(?,?,?)').run('user-b', 'b@example.test', 'User B');
  db.prepare('INSERT INTO memberships(id,organization_id,user_id) VALUES(?,?,?)').run('member-a', 'tenant-a', 'user-a');
  db.prepare('INSERT INTO memberships(id,organization_id,user_id) VALUES(?,?,?)').run('member-b', 'tenant-b', 'user-b');
  db.prepare('INSERT INTO station_accounts(user_id,organization_id,email,password_hash) VALUES(?,?,?,?)').run('user-a', 'tenant-a', 'a@example.test', 'pbkdf2-sha256$test$hash');
  if (tenantBMesGrant) db.prepare('INSERT INTO station_accounts(user_id,organization_id,email,password_hash) VALUES(?,?,?,?)').run('user-b', 'tenant-b', 'b@example.test', 'pbkdf2-sha256$test$hash-b');
  db.prepare('INSERT INTO station_grants(user_id,site,role,scope) VALUES(?,?,?,?)').run('user-a', 'mes', 'admin', 'back');
  if (tenantBMesGrant) db.prepare('INSERT INTO station_grants(user_id,site,role,scope) VALUES(?,?,?,?)').run('user-b', 'mes', 'admin', 'back');
  db.prepare('INSERT INTO station_grants(user_id,site,role,scope) VALUES(?,?,?,?)').run('user-a', 'erp', 'admin', 'back');
  db.prepare('INSERT INTO station_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run('secret-session-hash', 'user-a', 9999999999999);
  db.prepare('INSERT INTO mes_products(id,organization_id,sku,name) VALUES(?,?,?,?)').run('product-a', 'tenant-a', 'SKU-A', 'Product A');
  db.prepare('INSERT INTO mes_bom_versions(id,organization_id,product_id) VALUES(?,?,?)').run('bom-a', 'tenant-a', 'product-a');
  db.prepare('INSERT INTO mes_work_centers(id,organization_id,code,name) VALUES(?,?,?,?)').run('center-a', 'tenant-a', 'C-A', 'Center A');
  db.prepare('INSERT INTO mes_work_orders(id,organization_id,order_no,product_id,bom_version_id,target_quantity) VALUES(?,?,?,?,?,?)').run('wo-a', 'tenant-a', 'WO-A', 'product-a', 'bom-a', 10);
  db.prepare('INSERT INTO mes_operations(id,organization_id,work_order_id,sequence,work_center_id,name) VALUES(?,?,?,?,?,?)').run('op-a', 'tenant-a', 'wo-a', 1, 'center-a', 'Cut');
  db.prepare('INSERT INTO mes_production_reports(id,organization_id,work_order_id,operation_id,operator_id,good_quantity,scrap_quantity) VALUES(?,?,?,?,?,?,?)').run('report-a', 'tenant-a', 'wo-a', 'op-a', 'user-a', 4, 0);
  if (retryKey) {
    db.prepare('UPDATE mes_production_reports SET idempotency_key=? WHERE id=?').run('report-retry-001', 'report-a');
    const payload = JSON.stringify({action:'report',workOrderId:'wo-a',operationId:'op-a',goodQuantity:4,scrapQuantity:0,notes:'',idempotencyKey:'report-retry-001'});
    const requestHash = createHash('sha256').update(`user-a\0${payload}`).digest('hex');
    db.prepare('INSERT INTO idempotency_keys(id,organization_id,key,endpoint,request_hash,response_status,response_body) VALUES(?,?,?,?,?,?,?)').run('idem-a', 'tenant-a', 'report-retry-001', '/station/mes/report', requestHash, 200, JSON.stringify({workOrderId:'wo-a',reportId:'report-a',goodQuantity:4,scrapQuantity:0,totalCompleted:4,totalScrapped:0,status:'in_progress'}));
    db.prepare('INSERT INTO idempotency_keys(id,organization_id,key,endpoint,request_hash,response_status,response_body) VALUES(?,?,?,?,?,?,?)').run('idem-other', 'tenant-a', 'other-station-001', '/api/shop/checkout', 'other-hash', 200, '{}');
  }
  db.prepare('INSERT INTO mes_finished_goods_batches(id,organization_id,work_order_id,report_id,batch_number,quantity,status) VALUES(?,?,?,?,?,?,?)').run('batch-a', 'tenant-a', 'wo-a', 'report-a', 'BATCH-A', 2, 'released');
  db.prepare('INSERT INTO mes_finished_goods_batches(id,organization_id,work_order_id,report_id,batch_number,quantity,status) VALUES(?,?,?,?,?,?,?)').run('batch-b', 'tenant-a', 'wo-a', 'report-a', 'BATCH-B', 2, 'rework');
  const dispositionColumns = legacyDispositionSchema ? 'id,organization_id,batch_id,passed_quantity,failed_quantity,disposition' : 'id,organization_id,batch_id,passed_quantity,failed_quantity,disposition,reason';
  const dispositionValues = legacyDispositionSchema ? '?,?,?,?,?,?' : '?,?,?,?,?,?,?';
  db.prepare(`INSERT INTO mes_finished_goods_quality_dispositions(${dispositionColumns}) VALUES(${dispositionValues})`).run(...(legacyDispositionSchema ? ['disposition-a','tenant-a','batch-a',2,0,'release'] : ['disposition-a','tenant-a','batch-a',2,0,'release','passed']));
  db.prepare(`INSERT INTO mes_finished_goods_quality_dispositions(${dispositionColumns}) VALUES(${dispositionValues})`).run(...(legacyDispositionSchema ? ['disposition-b','tenant-a','batch-b',0,2,'rework'] : ['disposition-b','tenant-a','batch-b',0,2,'rework','failed']));
  db.prepare('INSERT INTO mes_finished_goods_inventory(id,organization_id,batch_id,quantity_on_hand) VALUES(?,?,?,?)').run('inventory-a', 'tenant-a', 'batch-a', 2);
  db.prepare('INSERT INTO mes_finished_goods_receipts(id,organization_id,batch_id,quantity,idempotency_key) VALUES(?,?,?,?,?)').run('receipt-a', 'tenant-a', 'batch-a', 2, 'receipt-key');
  db.prepare('INSERT INTO mes_finished_goods_resolutions(id,organization_id,batch_id,disposition,quantity,reason) VALUES(?,?,?,?,?,?)').run('resolution-a', 'tenant-a', 'batch-b', 'rework', 2, 'reinspect');
  db.prepare('INSERT INTO audit_events(id,organization_id,actor_id,actor_role,action,entity_type,entity_id) VALUES(?,?,?,?,?,?,?)').run('audit-a', 'tenant-a', 'user-a', 'admin', 'mes.report', 'work_order', 'wo-a');
  db.prepare('INSERT INTO audit_events(id,organization_id,actor_id,actor_role,action,entity_type,entity_id) VALUES(?,?,?,?,?,?,?)').run('audit-erp', 'tenant-a', 'user-a', 'admin', 'STATION_GRANT', 'ACCOUNT', 'user-a');
  // The source projection triggers correctly emit events during fixture setup;
  // clear delivery state to model an explicitly reconciled cutover snapshot.
  db.exec('DELETE FROM outbox_events');
  if (badReporter) db.prepare('INSERT INTO mes_downtime_events(id,organization_id,work_center_id,start_time,reason,reporter_id) VALUES(?,?,?,?,?,?)').run('down-a', 'tenant-a', 'center-a', '2026-01-01T00:00:00Z', 'test', 'missing-user');
  if (pendingOutbox) db.prepare('INSERT INTO outbox_events(id,organization_id,event_type,payload) VALUES(?,?,?,?)').run('event-a', 'tenant-a', 'mes.work-order.changed', '{}');
  if (processedOutbox) db.prepare("INSERT INTO outbox_events(id,organization_id,event_type,payload,status) VALUES(?,?,?,?,'processed')").run('event-processed', 'tenant-a', 'shop.paid', '{}');
  if (populatedErpMapping) db.prepare('INSERT INTO mes_erp_product_mappings(id,organization_id,mes_product_id,erp_item_id,warehouse_id,version,is_active) VALUES(?,?,?,?,?,?,?)').run('mapping-a', 'tenant-a', 'product-a', 'erp-item-a', 'warehouse-a', 1, 1);
  if (wal) db.exec('PRAGMA journal_mode=WAL');
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
  makeSharedSource(source);
  const before = sha256(source);
  const result = migrate(source, destination, ['tenant-a']);
  assert.equal(sha256(source), before);
  assert.deepEqual(result.organizationIds, ['tenant-a']);
  const db = new DatabaseSync(destination, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n, 1);
  assert.equal(db.prepare('SELECT id FROM organizations').get().id, 'tenant-a');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mes_work_orders WHERE organization_id='tenant-a'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(db.prepare("SELECT password_hash FROM station_accounts WHERE user_id='user-a'").get().password_hash, 'pbkdf2-sha256$test$hash');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM station_grants WHERE site='erp'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM station_sessions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mes_finished_goods_batches').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mes_finished_goods_quality_dispositions').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mes_finished_goods_inventory').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mes_finished_goods_receipts').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mes_finished_goods_resolutions').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'erp_%'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mes_erp_product_mappings'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE event_type LIKE 'mes.%'").get().n, 1, 'target projection is rebuilt from work orders');
  assert.equal(db.prepare('SELECT version FROM mes_repository_schema').get().version, 1);
  db.close();
});

test('preserves verified MES report retry key and response while excluding other station keys', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { retryKey: true });
  migrate(source, destination, ['tenant-a']);
  const db = new DatabaseSync(destination, { readOnly: true });
  const row = db.prepare("SELECT request_hash,response_status,response_body FROM idempotency_keys WHERE organization_id='tenant-a' AND key='report-retry-001' AND endpoint='/station/mes/report'").get();
  assert.match(row.request_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.response_status, 200);
  assert.equal(JSON.parse(row.response_body).reportId, 'report-a');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE endpoint='/api/shop/checkout'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mes_production_reports WHERE idempotency_key='report-retry-001'").get().n, 1);
  db.close();
  const replay = spawnSync('go', ['test', '-run', '^TestMESImportedRetryReplay$', '-count=1', '.'], {
    cwd: path.join(root, 'backend'),
    env: { ...process.env, MES_IMPORTED_RETRY_DB: destination },
    encoding: 'utf8',
  });
  assert.equal(replay.status, 0, `Go API replay verification failed:\n${replay.stdout}\n${replay.stderr}`);
});

test('upgrades the known early finished-goods disposition shape and preserves its rows', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { legacyDispositionSchema: true });
  migrate(source, destination, ['tenant-a']);
  const db = new DatabaseSync(destination, { readOnly: true });
  const row = db.prepare("SELECT id,quality_check_id,reinspection_after,reason FROM mes_finished_goods_quality_dispositions WHERE id='disposition-a'").get();
  assert.deepEqual({...row}, {id:'disposition-a',quality_check_id:null,reinspection_after:0,reason:''});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mes_finished_goods_quality_dispositions').get().n, 2);
  db.close();
});

test('refuses existing destination without changing source or destination', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source); fs.writeFileSync(destination, 'preserve me');
  const beforeSource = sha256(source), beforeDestination = sha256(destination);
  assert.throws(() => migrate(source, destination, ['tenant-a']));
  assert.equal(sha256(source), beforeSource);
  assert.equal(sha256(destination), beforeDestination);
});

test('fails closed on unresolved MES references and removes partial output', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { badReporter: true });
  assert.throws(() => migrate(source, destination, ['tenant-a']), /unresolved/i);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readdirSync(dir).some(name => name.startsWith('.mes-migration-')), false);
});

test('blocks a source with unresolved MES outbox rows', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { pendingOutbox: true });
  assert.throws(() => migrate(source, destination, ['tenant-a']), /outbox contains/);
  assert.equal(fs.existsSync(destination), false);
});

test('also blocks processed or unrelated station outbox rows instead of silently dropping them', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { processedOutbox: true });
  assert.throws(() => migrate(source, destination, ['tenant-a']), /Source outbox contains/);
  assert.equal(fs.existsSync(destination), false);
});

test('refuses a retained identity that also belongs to an unselected tenant', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source); addForeignMembership(source);
  assert.throws(() => migrate(source, destination, ['tenant-a']), /unselected tenant/);
  assert.equal(fs.existsSync(destination), false);
});

test('refuses unsupported shared migration ledger before creating any output', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { extraVersion: true });
  assert.throws(() => migrate(source, destination, ['tenant-a']), /Unsupported shared Go migrations/);
  assert.equal(fs.existsSync(destination), false);
});

test('refuses newer shared profolio MES tables not present in target schema', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { extraMesTable: true });
  assert.throws(() => migrate(source, destination, ['tenant-a']), /Unknown MES tables/);
  assert.equal(fs.existsSync(destination), false);
});

test('refuses populated MES-to-ERP mappings rather than copying cross-station references', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { populatedErpMapping: true });
  assert.throws(() => migrate(source, destination, ['tenant-a']), /Cross-station MES\/ERP table/);
  assert.equal(fs.existsSync(destination), false);
});

test('uses only the verified snapshot when the live source changes after snapshot creation', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { tenantBMesGrant: true, wal: true });
  const result = migrate(source, destination, ['tenant-b'], {
    afterSnapshot() {
      const changed = new DatabaseSync(source);
      changed.prepare("UPDATE station_grants SET site='erp' WHERE user_id='user-b' AND site='mes'").run();
      changed.close();
    },
  });
  assert.deepEqual(result.organizationIds, ['tenant-b']);
  const db = new DatabaseSync(destination, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM station_grants WHERE user_id='user-b' AND site='mes'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE id='tenant-b'").get().n, 1);
  db.close();
});
