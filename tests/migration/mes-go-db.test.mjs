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

function makeSharedSource(file, { badReporter = false, pendingOutbox = false, processedOutbox = false, nonProcessedOutboxStatus = '', extraMesTable = false, extraVersion = false, populatedErpMapping = false, tenantBMesGrant = false, retryKey = false, actualMesRetryKey = false, legacyDispositionSchema = false, wal = false, sourceVariant = 'complete', partialFinishedGoods = false, emptyMesIdentity = false, mesStartAudit = false } = {}) {
  const db = new DatabaseSync(file);
  // Match the shared Portfolio Go database bootstrap, including its actual
  // common multi-station schema and migration ledger rather than the standalone
  // MES repository's reduced `mes_initial.sql` source.
  const sourceMigrations = ['0000_spicy_bromley.sql', '0001_transaction_guards.sql', '0002_dining_takeout.sql', '0003_mes_projection.sql', '0004_station_identity.sql', '0005_traffic_lab.sql'];
  if (sourceVariant !== 'projection-only') sourceMigrations.push('0006_mes_finished_goods.sql', '0007_mes_finished_goods_resolutions.sql');
  for (const name of sourceMigrations) {
    db.exec(fs.readFileSync(path.join(migrations, name), 'utf8'));
  }
  if (sourceVariant !== 'projection-only') {
    for (const name of ['0008_mes_erp_mapping.sql', '0009_erp_mes_receipts.sql']) {
      db.exec(fs.readFileSync(path.join(root, 'tests', 'migration', 'fixtures', name), 'utf8'));
    }
  }
  if (partialFinishedGoods) db.exec('DROP TABLE mes_finished_goods_resolutions;');
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
  if (!emptyMesIdentity) {
    db.prepare('INSERT INTO station_accounts(user_id,organization_id,email,password_hash) VALUES(?,?,?,?)').run('user-a', 'tenant-a', 'a@example.test', 'pbkdf2-sha256$test$hash');
    if (tenantBMesGrant) db.prepare('INSERT INTO station_accounts(user_id,organization_id,email,password_hash) VALUES(?,?,?,?)').run('user-b', 'tenant-b', 'b@example.test', 'pbkdf2-sha256$test$hash-b');
    db.prepare('INSERT INTO station_grants(user_id,site,role,scope) VALUES(?,?,?,?)').run('user-a', 'mes', 'admin', 'back');
    if (tenantBMesGrant) db.prepare('INSERT INTO station_grants(user_id,site,role,scope) VALUES(?,?,?,?)').run('user-b', 'mes', 'admin', 'back');
    db.prepare('INSERT INTO station_grants(user_id,site,role,scope) VALUES(?,?,?,?)').run('user-a', 'erp', 'admin', 'back');
  }
  if (!emptyMesIdentity) db.prepare('INSERT INTO station_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run('secret-session-hash', 'user-a', 9999999999999);
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
  if (actualMesRetryKey) {
    db.prepare('UPDATE mes_production_reports SET idempotency_key=? WHERE id=?').run('source-report-retry-001', 'report-a');
    db.exec("UPDATE mes_work_orders SET status='in_progress' WHERE id='wo-a'");
    db.exec("UPDATE mes_work_orders SET completed_quantity=4 WHERE id='wo-a'");
    db.prepare('INSERT INTO idempotency_keys(id,organization_id,key,endpoint,request_hash,response_status,response_body) VALUES(?,?,?,?,?,?,?)').run(
      'idem-source-mes', 'tenant-a', 'source-report-retry-001', '/api/mes/report', 'source-report-retry-001', 200,
      JSON.stringify({ reportId: 'report-a', goodQuantity: 4, scrapQuantity: 0, totalCompleted: 4, totalScrapped: 0, orderStatus: 'in_progress' }),
    );
  }
  if (sourceVariant !== 'projection-only') {
    db.prepare('INSERT INTO mes_finished_goods_batches(id,organization_id,work_order_id,report_id,batch_number,quantity,status) VALUES(?,?,?,?,?,?,?)').run('batch-a', 'tenant-a', 'wo-a', 'report-a', 'BATCH-A', 2, 'released');
    db.prepare('INSERT INTO mes_finished_goods_batches(id,organization_id,work_order_id,report_id,batch_number,quantity,status) VALUES(?,?,?,?,?,?,?)').run('batch-b', 'tenant-a', 'wo-a', 'report-a', 'BATCH-B', 2, 'rework');
    const dispositionColumns = legacyDispositionSchema ? 'id,organization_id,batch_id,passed_quantity,failed_quantity,disposition' : 'id,organization_id,batch_id,passed_quantity,failed_quantity,disposition,reason';
    const dispositionValues = legacyDispositionSchema ? '?,?,?,?,?,?' : '?,?,?,?,?,?,?';
    db.prepare(`INSERT INTO mes_finished_goods_quality_dispositions(${dispositionColumns}) VALUES(${dispositionValues})`).run(...(legacyDispositionSchema ? ['disposition-a','tenant-a','batch-a',2,0,'release'] : ['disposition-a','tenant-a','batch-a',2,0,'release','passed']));
    db.prepare(`INSERT INTO mes_finished_goods_quality_dispositions(${dispositionColumns}) VALUES(${dispositionValues})`).run(...(legacyDispositionSchema ? ['disposition-b','tenant-a','batch-b',0,2,'rework'] : ['disposition-b','tenant-a','batch-b',0,2,'rework','failed']));
    db.prepare('INSERT INTO mes_finished_goods_inventory(id,organization_id,batch_id,quantity_on_hand) VALUES(?,?,?,?)').run('inventory-a', 'tenant-a', 'batch-a', 2);
    db.prepare('INSERT INTO mes_finished_goods_receipts(id,organization_id,batch_id,quantity,idempotency_key) VALUES(?,?,?,?,?)').run('receipt-a', 'tenant-a', 'batch-a', 2, 'receipt-key');
    if (!partialFinishedGoods) db.prepare('INSERT INTO mes_finished_goods_resolutions(id,organization_id,batch_id,disposition,quantity,reason) VALUES(?,?,?,?,?,?)').run('resolution-a', 'tenant-a', 'batch-b', 'rework', 2, 'reinspect');
  }
  db.prepare('INSERT INTO audit_events(id,organization_id,actor_id,actor_role,action,entity_type,entity_id) VALUES(?,?,?,?,?,?,?)').run('audit-a', 'tenant-a', 'user-a', 'admin', mesStartAudit ? 'MES_START' : 'mes.report', mesStartAudit ? 'mes' : 'work_order', 'wo-a');
  db.prepare('INSERT INTO audit_events(id,organization_id,actor_id,actor_role,action,entity_type,entity_id) VALUES(?,?,?,?,?,?,?)').run('audit-erp', 'tenant-a', 'user-a', 'admin', 'STATION_GRANT', 'ACCOUNT', 'user-a');
  // The source projection triggers correctly emit events during fixture setup;
  // clear delivery state to model an explicitly reconciled cutover snapshot.
  db.exec('DELETE FROM outbox_events');
  if (badReporter) db.prepare('INSERT INTO mes_downtime_events(id,organization_id,work_center_id,start_time,reason,reporter_id) VALUES(?,?,?,?,?,?)').run('down-a', 'tenant-a', 'center-a', '2026-01-01T00:00:00Z', 'test', 'missing-user');
  if (pendingOutbox) db.prepare('INSERT INTO outbox_events(id,organization_id,event_type,payload) VALUES(?,?,?,?)').run('event-a', 'tenant-a', 'mes.work-order.changed', '{}');
  if (processedOutbox) {
    db.prepare("INSERT INTO outbox_events(id,organization_id,event_type,payload,status) VALUES(?,?,?,?,'processed')").run('event-processed-mes', 'tenant-a', 'mes.work-order.changed', '{"workOrderId":"wo-a"}');
    db.prepare("INSERT INTO outbox_events(id,organization_id,event_type,payload,status) VALUES(?,?,?,?,'processed')").run('event-processed-other', 'tenant-a', 'shop.paid', '{"orderId":"synthetic-only"}');
  }
  if (nonProcessedOutboxStatus) db.prepare('INSERT INTO outbox_events(id,organization_id,event_type,payload,status) VALUES(?,?,?,?,?)').run('event-nonprocessed', 'tenant-a', 'mes.work-order.changed', '{}', nonProcessedOutboxStatus);
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

test('imports a projection-only 0003 source when the full finished-goods schema is absent', t => {
  const dir = temporary(t), source = path.join(dir, 'projection-only.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { sourceVariant: 'projection-only' });
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  assert.deepEqual(sourceDb.prepare('SELECT name FROM suite_migrations ORDER BY name').all().map(row => row.name), ['0003_mes_projection']);
  assert.equal(sourceDb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'mes_finished_goods_%'").get().n, 0);
  sourceDb.close();

  const result = migrate(source, destination, ['tenant-a']);
  assert.equal(result.targetRows.mes_work_orders, 1);
  const target = new DatabaseSync(destination, { readOnly: true });
  for (const table of ['mes_finished_goods_batches', 'mes_finished_goods_quality_dispositions', 'mes_finished_goods_inventory', 'mes_finished_goods_receipts', 'mes_finished_goods_resolutions']) {
    assert.equal(target.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n, 0, `${table} should be initialized empty in target`);
  }
  assert.equal(target.prepare('SELECT COUNT(*) AS n FROM mes_work_orders').get().n, 1);
  target.close();
});

test('refuses a partial finished-goods schema even when the remaining tables look compatible', t => {
  const dir = temporary(t), source = path.join(dir, 'partial-finished-goods.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { partialFinishedGoods: true });
  assert.throws(() => migrate(source, destination, ['tenant-a']), /finished.goods|Required source table missing/i);
  assert.equal(fs.existsSync(destination), false);
});

test('preserves scoped MES_START audit rows whose action uses the legacy uppercase form', t => {
  const dir = temporary(t), source = path.join(dir, 'legacy-audit.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { mesStartAudit: true });
  migrate(source, destination, ['tenant-a']);
  const db = new DatabaseSync(destination, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='MES_START' AND entity_type='mes'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='STATION_GRANT'").get().n, 0);
  db.close();
});

test('refuses publication when source identities have no MES account or grant mapping', t => {
  const dir = temporary(t), source = path.join(dir, 'unmapped-identity.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { emptyMesIdentity: true });
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  assert.equal(sourceDb.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) AS n FROM memberships').get().n, 2);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) AS n FROM station_accounts').get().n, 0);
  assert.equal(sourceDb.prepare("SELECT COUNT(*) AS n FROM station_grants WHERE site='mes'").get().n, 0);
  sourceDb.close();

  assert.throws(() => migrate(source, destination, ['tenant-a']), /station account|MES grant|identity.*mapping|access.*enroll/i);
  assert.equal(fs.existsSync(destination), false);
});

test('refuses the observed source report-retry contract until its identity and response mapping is reviewed', t => {
  const dir = temporary(t), source = path.join(dir, 'source-report-retry.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { actualMesRetryKey: true });
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  assert.equal(sourceDb.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE endpoint='/api/mes/report'").get().n, 1);
  assert.equal(sourceDb.prepare("SELECT COUNT(*) AS n FROM mes_production_reports WHERE idempotency_key='source-report-retry-001'").get().n, 1);
  sourceDb.close();

  assert.throws(() => migrate(source, destination, ['tenant-a']), /report retry.*mapping|idempotency.*mapping|unverifiable.*retry/i);
  assert.equal(fs.existsSync(destination), false);
});

test('converts a reviewed MES retry using the committed report and enrolled actor', t => {
  const dir = temporary(t), source = path.join(dir, 'legacy-replay.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { actualMesRetryKey: true });
  const fixture = new DatabaseSync(source);
  fixture.prepare('UPDATE mes_production_reports SET notes=? WHERE id=?').run('校驗 <&>', 'report-a');
  fixture.exec('DELETE FROM outbox_events');
  fixture.close();
  const sourceHash = sha256(source);
  migrate(source, destination, ['tenant-a'], {
    legacyReportMappings: [{ organizationId: 'tenant-a', legacyOperatorId: 'user-a', stationUserId: 'user-a' }],
  });

  const target = new DatabaseSync(destination, { readOnly: true });
  try {
    const row = target.prepare("SELECT endpoint,request_hash,response_body FROM idempotency_keys WHERE key='source-report-retry-001'").get();
    const nativeCommand = String.raw`{"action":"report","workOrderId":"wo-a","operationId":"op-a","goodQuantity":4,"scrapQuantity":0,"notes":"校驗 \u003c\u0026\u003e","idempotencyKey":"source-report-retry-001"}`;
    assert.equal(row.endpoint, '/station/mes/report');
    assert.equal(row.request_hash, createHash('sha256').update('user-a\0' + nativeCommand).digest('hex'));
    assert.deepEqual(JSON.parse(row.response_body), {
      workOrderId: 'wo-a', reportId: 'report-a', goodQuantity: 4, scrapQuantity: 0,
      totalCompleted: 4, totalScrapped: 0, status: 'in_progress',
    });
    assert.equal(target.prepare("SELECT count(*) AS n FROM mes_production_reports WHERE id='report-a'").get().n, 1);
    assert.equal(sha256(source), sourceHash);
  } finally {
    target.close();
  }
  const replay = spawnSync('go', ['test', '-run', '^TestMESImportedRetryReplay$', '-count=1', '.'], {
    cwd: path.join(root, 'backend'),
    env: { ...process.env, MES_IMPORTED_RETRY_DB: destination, MES_IMPORTED_RETRY_LEGACY: '1' },
    encoding: 'utf8',
  });
  assert.equal(replay.status, 0, `Go API legacy replay failed:\n${replay.stdout}\n${replay.stderr}`);
});

test('refuses reviewed legacy retry conversion when cached quantities disagree with the report', t => {
  const dir = temporary(t), source = path.join(dir, 'invalid-replay.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { actualMesRetryKey: true });
  const fixture = new DatabaseSync(source);
  fixture.exec("UPDATE idempotency_keys SET response_body=json_set(response_body,'$.goodQuantity',99) WHERE endpoint='/api/mes/report'");
  fixture.close();
  assert.throws(() => migrate(source, destination, ['tenant-a'], {
    legacyReportMappings: [{ organizationId: 'tenant-a', legacyOperatorId: 'user-a', stationUserId: 'user-a' }],
  }), /cached.*quantit|legacy retry.*report mismatch/i);
  assert.equal(fs.existsSync(destination), false);
});

test('refuses to overwrite an existing native key during legacy retry conversion', t => {
  const dir = temporary(t), source = path.join(dir, 'retry-conflict.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { actualMesRetryKey: true, retryKey: true });
  const fixture = new DatabaseSync(source);
  fixture.exec("UPDATE idempotency_keys SET key='source-report-retry-001' WHERE endpoint='/station/mes/report'");
  fixture.close();
  assert.throws(() => migrate(source, destination, ['tenant-a'], {
    legacyReportMappings: [{ organizationId: 'tenant-a', legacyOperatorId: 'user-a', stationUserId: 'user-a' }],
  }), /conflicts with an existing native retry key/);
  assert.equal(fs.existsSync(destination), false);
});

test('keeps processed source outbox history in an explicit immutable archive and rebuilds target events', t => {
  const dir = temporary(t), source = path.join(dir, 'processed-outbox.sqlite'), destination = path.join(dir, 'mes.sqlite'), archive = path.join(dir, 'source-archive.sqlite');
  makeSharedSource(source, { processedOutbox: true });
  const sourceHash = sha256(source);
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  const sourceRows = sourceDb.prepare('SELECT id,organization_id,event_type,payload,status,retry_count,created_at FROM outbox_events ORDER BY id').all();
  sourceDb.close();
  const expectedOutboxDigest = createHash('sha256').update(JSON.stringify(sourceRows.map(row => Object.values(row)))).digest('hex');

  const result = migrate(source, destination, ['tenant-a'], {
    outboxReconciliation: { reviewed: true, archivePath: archive },
  });
  assert.equal(sha256(source), sourceHash, 'source remains unchanged');
  assert.equal(fs.existsSync(archive), true, 'reviewed source archive is retained after migration');
  assert.equal(result.outboxReconciliation.rowCount, 2);
  assert.deepEqual(result.outboxReconciliation.statusCounts, { processed: 2 });
  assert.equal(result.outboxReconciliation.contentSha256, expectedOutboxDigest);
  assert.match(result.outboxReconciliation.archiveSha256, /^[0-9a-f]{64}$/);
  assert.equal(sha256(archive), result.outboxReconciliation.archiveSha256, 'manifest archive digest verifies the retained file');

  const archived = new DatabaseSync(archive, { readOnly: true });
  assert.equal(archived.prepare('SELECT COUNT(*) AS n FROM outbox_events').get().n, 2);
  assert.equal(archived.prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE status!='processed'").get().n, 0);
  archived.close();
  const target = new DatabaseSync(destination, { readOnly: true });
  assert.equal(target.prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE event_type='shop.paid'").get().n, 0, 'processed external events are not replayed');
  assert.equal(target.prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE event_type='mes.work-order.changed'").get().n, 1, 'MES projection is rebuilt from imported work orders');
  target.close();
});

test('requires an explicit reviewed archive path before reconciling processed outbox history', t => {
  const dir = temporary(t), source = path.join(dir, 'processed-outbox.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { processedOutbox: true });
  assert.throws(() => migrate(source, destination, ['tenant-a'], {
    outboxReconciliation: { reviewed: true },
  }), /archive.*required|archive path|retain.*archive/i);
  assert.equal(fs.existsSync(destination), false);
});

test('does not archive or publish outbox rows with pending, failed, or unknown status', async t => {
  for (const status of ['pending', 'failed', 'unknown']) {
    await t.test(status, t => {
      const dir = temporary(t), source = path.join(dir, 'nonprocessed-outbox.sqlite'), destination = path.join(dir, 'mes.sqlite'), archive = path.join(dir, 'source-archive.sqlite');
      makeSharedSource(source, { nonProcessedOutboxStatus: status });
      assert.throws(() => migrate(source, destination, ['tenant-a'], {
        outboxReconciliation: { reviewed: true, archivePath: archive },
      }), /outbox|status|delivery/i);
      assert.equal(fs.existsSync(destination), false);
    });
  }
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

test('refuses publication when the live source changes after snapshot creation', t => {
  const dir = temporary(t), source = path.join(dir, 'shared.sqlite'), destination = path.join(dir, 'mes.sqlite');
  makeSharedSource(source, { tenantBMesGrant: true, wal: true });
  assert.throws(() => migrate(source, destination, ['tenant-b'], {
    afterSnapshot() {
      const changed = new DatabaseSync(source);
      changed.prepare("UPDATE station_grants SET site='erp' WHERE user_id='user-b' AND site='mes'").run();
      changed.close();
    },
  }), /source.*(changed|stable)|unstable.*source|snapshot.*changed/i);
  assert.equal(fs.existsSync(destination), false, 'a moving source must not publish a partial cutover target');
});
