#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convertLegacyReportRetries } from './mes-legacy-report-replay.mjs';

export const MES_TABLES = [
  'mes_products', 'mes_bom_versions', 'mes_bom_items', 'mes_work_centers',
  'mes_work_orders', 'mes_operations', 'mes_material_lots',
  'mes_work_order_materials', 'mes_production_reports', 'mes_quality_checks',
  'mes_downtime_events', 'mes_finished_goods_batches',
  'mes_finished_goods_quality_dispositions', 'mes_finished_goods_inventory',
  'mes_finished_goods_receipts', 'mes_finished_goods_resolutions',
];
export const COPY_TABLES = ['organizations', 'users', 'memberships', ...MES_TABLES, 'audit_events', 'station_accounts', 'station_grants'];
export const RESET_TABLES = ['station_sessions', 'station_login_limits', 'demo_seed_states', 'traffic_runs', 'traffic_records'];
export const REBUILT_TABLES = ['outbox_events', 'suite_migrations', 'mes_projection_revisions'];
export const EXCLUDED_PREFIXES = ['erp_', 'pos_', 'crm_', 'dining_', 'shop_'];
export const CROSS_STATION_TABLES = ['mes_erp_product_mappings', 'erp_mes_receipt_postings'];

const finishedGoodsTables = MES_TABLES.filter(table => table.startsWith('mes_finished_goods_'));
const finishedGoodsVersions = ['0006_mes_finished_goods', '0007_mes_finished_goods_resolutions'];
const mesAudit = "(action LIKE 'mes.%' OR (action='MES_START' AND entity_type='mes'))";

const q = value => `"${String(value).replaceAll('"', '""')}"`;
const sqlLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const tables = db => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name));
const columns = (db, table) => db.prepare(`PRAGMA table_info(${q(table)})`).all().map(row => row.name);
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).get().n;

function assertIntegrity(db, label) {
  const checks = db.prepare('PRAGMA integrity_check').all();
  if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw new Error(`${label} integrity check failed`);
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) throw new Error(`${label} foreign key check failed (${violations.length} rows)`);
}

function readTable(db, table) {
  const names = columns(db, table);
  const order = names.map(q).join(',');
  return db.prepare(`SELECT ${order} FROM ${q(table)} ORDER BY ${order}`).all();
}

function assertRowsEqual(sourceRows, targetRows, table) {
  if (sourceRows.length !== targetRows.length) throw new Error(`Row count mismatch: ${table}`);
  for (let i = 0; i < sourceRows.length; i++) {
    for (const key of Object.keys(sourceRows[i])) {
      const a = sourceRows[i][key], b = targetRows[i][key];
      if (Buffer.isBuffer(a) || a instanceof Uint8Array || Buffer.isBuffer(b) || b instanceof Uint8Array) {
        if (!Buffer.from(a ?? []).equals(Buffer.from(b ?? []))) throw new Error(`Row value mismatch: ${table}.${key}`);
      } else if (a !== b) throw new Error(`Row value mismatch: ${table}.${key}`);
    }
  }
}

function copyRows(source, target, table, where, params) {
  const sourceCols = columns(source, table);
  const targetCols = columns(target, table);
  const optionalFinishedQualityDefaults = table === 'mes_finished_goods_quality_dispositions'
    ? new Map([['quality_check_id', 'NULL'], ['reinspection_after', '0'], ['reason', "''"]])
    : new Map();
  const sourceSet = new Set(sourceCols), targetSet = new Set(targetCols);
  const extra = sourceCols.filter(col => !targetSet.has(col));
  const missing = targetCols.filter(col => !sourceSet.has(col));
  if (extra.length || missing.some(col => !optionalFinishedQualityDefaults.has(col))) throw new Error(`Schema mismatch: ${table}`);
  const fields = targetCols.map(q).join(',');
  const projection = targetCols.map(col => sourceSet.has(col) ? q(col) : `${optionalFinishedQualityDefaults.get(col)} AS ${q(col)}`).join(',');
  const order = sourceCols.map(q).join(',');
  const sourceRows = source.prepare(`SELECT ${projection} FROM ${q(table)} WHERE ${where} ORDER BY ${order}`).all(...params);
  const insert = target.prepare(`INSERT INTO ${q(table)} (${fields}) VALUES (${targetCols.map(() => '?').join(',')})`);
  for (const row of sourceRows) insert.run(...targetCols.map(col => row[col]));
  const targetRows = target.prepare(`SELECT ${fields} FROM ${q(table)} WHERE ${where} ORDER BY ${fields}`).all(...params);
  assertRowsEqual(sourceRows, targetRows, table);
  return sourceRows.length;
}

function manifestSnapshot(db) {
  const digest = createHash('sha256');
  for (const table of [...tables(db)].sort()) {
    digest.update(table);
    if (table === 'sqlite_sequence') continue;
    const names = columns(db, table);
    if (!names.length) continue;
    for (const row of readTable(db, table)) digest.update(JSON.stringify(names.map(name => row[name]?.toString?.() ?? row[name] ?? null)));
  }
  return digest.digest('hex');
}

function assertSource(source) {
  assertIntegrity(source, 'Source');
  const names = tables(source);
  // The shared Portfolio Go database is identified by its projection migration
  // ledger, not by the independent MES repository marker.
  if (!names.has('organizations') || !names.has('suite_migrations')) throw new Error('Unsupported shared Go source database: missing organizations or suite_migrations');
  if (names.has('mes_repository_schema')) throw new Error('Source is already marked as an independent MES database, not the shared Portfolio Go database');
  const applied = source.prepare('SELECT name FROM suite_migrations ORDER BY name').all().map(row => row.name);
  if (!applied.includes('0003_mes_projection')) throw new Error('Unsupported shared Go source version: 0003_mes_projection is absent');
  const allowedVersions = new Set(['0003_mes_projection', ...finishedGoodsVersions]);
  const unknownVersions = applied.filter(name => !allowedVersions.has(name));
  if (unknownVersions.length) throw new Error(`Unsupported shared Go migrations: ${unknownVersions.join(', ')}`);
  const goodsTablesPresent = finishedGoodsTables.filter(table => names.has(table)).length;
  const goodsVersionsPresent = finishedGoodsVersions.filter(version => applied.includes(version)).length;
  const projectionOnly = goodsTablesPresent === 0 && goodsVersionsPresent === 0;
  if (!projectionOnly && (goodsTablesPresent !== finishedGoodsTables.length || goodsVersionsPresent !== finishedGoodsVersions.length)) {
    throw new Error('Inconsistent source finished-goods tables and migration markers');
  }
  for (const table of COPY_TABLES) {
    if (!names.has(table) && !(projectionOnly && finishedGoodsTables.includes(table))) {
      throw new Error(`Required source table missing: ${table}`);
    }
  }
  if (!names.has('idempotency_keys')) throw new Error('Required source table missing: idempotency_keys');
  for (const table of RESET_TABLES) if (!names.has(table)) throw new Error(`Required source table missing: ${table}`);
  for (const table of REBUILT_TABLES) if (!names.has(table)) throw new Error(`Required source table missing: ${table}`);
  const unknownMes = [...names].filter(name => name.startsWith('mes_') && !MES_TABLES.includes(name) && !['mes_repository_schema', 'mes_projection_revisions', ...CROSS_STATION_TABLES].includes(name));
  if (unknownMes.length) throw new Error(`Unknown MES tables require review: ${unknownMes.sort().join(', ')}`);
  for (const table of CROSS_STATION_TABLES) {
    if (names.has(table) && count(source, table) !== 0) throw new Error(`Cross-station MES/ERP table ${table} contains rows; resolve the integration before migration`);
  }
  return names;
}

function checkOutbox(source, reconciliation, sourceFile, destinationFile) {
  const rows = source.prepare('SELECT id,organization_id,event_type,payload,status,retry_count,created_at FROM outbox_events ORDER BY id').all();
  if (!rows.length) return undefined;
  if (rows.some(row => row.status !== 'processed')) throw new Error('Source outbox contains unresolved delivery statuses');
  if (reconciliation?.reviewed !== true || typeof reconciliation.archivePath !== 'string' || !reconciliation.archivePath.trim()) {
    throw new Error('Source outbox contains processed rows; an explicit reviewed archive path is required');
  }
  const archivePath = path.resolve(reconciliation.archivePath);
  const parent = fs.statSync(path.dirname(archivePath));
  if (!parent.isDirectory() || (process.platform !== 'win32' && (parent.mode & 0o077) !== 0)) {
    throw new Error('Source archive requires an existing private parent directory');
  }
  if ([sourceFile, destinationFile].includes(archivePath) || fs.existsSync(archivePath)) {
    throw new Error('Source archive path must be distinct and unused');
  }
  return {
    archivePath,
    rowCount: rows.length,
    statusCounts: { processed: rows.length },
    contentSha256: createHash('sha256').update(JSON.stringify(rows.map(row => Object.values(row)))).digest('hex'),
  };
}

function publishArchive(snapshot, reconciliation) {
  const privateDir = fs.mkdtempSync(path.join(path.dirname(reconciliation.archivePath), '.mes-archive-'));
  const temporary = path.join(privateDir, 'source.sqlite');
  try {
    fs.copyFileSync(snapshot, temporary, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(temporary, 0o400);
    const hash = createHash('sha256');
    const fd = fs.openSync(temporary, process.platform === 'win32' ? 'r+' : 'r');
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let read;
      while ((read = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, read));
      if (process.platform !== 'win32') fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(temporary, reconciliation.archivePath);
    return { ...reconciliation, archiveSha256: hash.digest('hex') };
  } finally {
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
}

function identityPlan(source, organizationIds) {
  const orgMarks = organizationIds.map(() => '?').join(',');
  const userIds = new Set();
  const add = (sql, params = organizationIds) => {
    for (const row of source.prepare(sql).all(...params)) userIds.add(row.user_id ?? row.actor_id ?? row.reporter_id ?? row.inspector_id ?? row.operator_id);
  };
  add(`SELECT user_id FROM memberships WHERE organization_id IN (${orgMarks})`);
  add(`SELECT user_id FROM station_accounts WHERE organization_id IN (${orgMarks})`);
  add(`SELECT actor_id FROM audit_events WHERE organization_id IN (${orgMarks}) AND ${mesAudit}`);
  add(`SELECT reporter_id FROM mes_downtime_events WHERE organization_id IN (${orgMarks})`);
  add(`SELECT operator_id FROM mes_production_reports WHERE organization_id IN (${orgMarks})`);
  add(`SELECT inspector_id FROM mes_quality_checks WHERE organization_id IN (${orgMarks})`);
  userIds.delete(undefined); userIds.delete(null); userIds.delete('');
  const ids = [...userIds].sort();
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    const found = new Set(source.prepare(`SELECT id FROM users WHERE id IN (${marks})`).all(...ids).map(row => row.id));
    const missing = ids.filter(id => !found.has(id));
    if (missing.length) throw new Error(`Unresolved MES identity references: ${missing.join(', ')}`);
    const foreignMemberships = source.prepare(`SELECT user_id,organization_id FROM memberships WHERE user_id IN (${marks}) AND organization_id NOT IN (${orgMarks})`).all(...ids, ...organizationIds);
    if (foreignMemberships.length) throw new Error(`Identity is also a member of unselected tenant(s): ${foreignMemberships.map(r => `${r.user_id}@${r.organization_id}`).join(', ')}`);
    // station_accounts is keyed globally by user_id. Copying an account whose
    // same identity has another tenant account could merge unrelated access.
    const accountRows = source.prepare(`SELECT user_id,organization_id FROM station_accounts WHERE user_id IN (${marks})`).all(...ids);
    const selected = new Set(organizationIds);
    const crossTenant = accountRows.filter(row => !selected.has(row.organization_id));
    if (crossTenant.length) throw new Error(`Identity has station accounts outside selected MES tenants: ${crossTenant.map(r => r.user_id).join(', ')}`);
  }
  return ids;
}

function assertMesReferences(db) {
  const checks = [
    ['MES BOM product', `SELECT v.id FROM mes_bom_versions v LEFT JOIN mes_products p ON p.organization_id=v.organization_id AND p.id=v.product_id WHERE p.id IS NULL`],
    ['MES BOM item version', `SELECT i.id FROM mes_bom_items i LEFT JOIN mes_bom_versions v ON v.organization_id=i.organization_id AND v.id=i.bom_version_id WHERE v.id IS NULL`],
    ['MES work order product', `SELECT w.id FROM mes_work_orders w LEFT JOIN mes_products p ON p.organization_id=w.organization_id AND p.id=w.product_id WHERE p.id IS NULL`],
    ['MES work order BOM', `SELECT w.id FROM mes_work_orders w LEFT JOIN mes_bom_versions b ON b.organization_id=w.organization_id AND b.id=w.bom_version_id AND b.product_id=w.product_id WHERE b.id IS NULL`],
    ['MES operation work order/work center', `SELECT o.id FROM mes_operations o LEFT JOIN mes_work_orders w ON w.organization_id=o.organization_id AND w.id=o.work_order_id LEFT JOIN mes_work_centers c ON c.organization_id=o.organization_id AND c.id=o.work_center_id WHERE w.id IS NULL OR c.id IS NULL`],
    ['MES material issue work order/lot', `SELECT m.id FROM mes_work_order_materials m LEFT JOIN mes_work_orders w ON w.organization_id=m.organization_id AND w.id=m.work_order_id LEFT JOIN mes_material_lots l ON l.organization_id=m.organization_id AND l.id=m.material_lot_id WHERE w.id IS NULL OR l.id IS NULL`],
    ['MES production report references', `SELECT r.id FROM mes_production_reports r LEFT JOIN mes_work_orders w ON w.organization_id=r.organization_id AND w.id=r.work_order_id LEFT JOIN mes_operations o ON o.organization_id=r.organization_id AND o.id=r.operation_id AND o.work_order_id=r.work_order_id LEFT JOIN users u ON u.id=r.operator_id WHERE w.id IS NULL OR o.id IS NULL OR u.id IS NULL`],
    ['MES quality references', `SELECT q.id FROM mes_quality_checks q LEFT JOIN mes_work_orders w ON w.organization_id=q.organization_id AND w.id=q.work_order_id LEFT JOIN mes_production_reports r ON r.organization_id=q.organization_id AND r.id=q.report_id AND r.work_order_id=q.work_order_id LEFT JOIN users u ON u.id=q.inspector_id WHERE w.id IS NULL OR (q.report_id IS NOT NULL AND r.id IS NULL) OR u.id IS NULL`],
    ['MES downtime references', `SELECT d.id FROM mes_downtime_events d LEFT JOIN mes_work_centers c ON c.organization_id=d.organization_id AND c.id=d.work_center_id LEFT JOIN users u ON u.id=d.reporter_id WHERE c.id IS NULL OR u.id IS NULL`],
    ['MES finished goods batch references', `SELECT b.id FROM mes_finished_goods_batches b LEFT JOIN mes_work_orders w ON w.organization_id=b.organization_id AND w.id=b.work_order_id LEFT JOIN mes_production_reports r ON r.organization_id=b.organization_id AND r.id=b.report_id AND r.work_order_id=b.work_order_id WHERE w.id IS NULL OR r.id IS NULL`],
    ['MES finished goods quality references', `SELECT q.id FROM mes_finished_goods_quality_dispositions q LEFT JOIN mes_finished_goods_batches b ON b.organization_id=q.organization_id AND b.id=q.batch_id LEFT JOIN mes_quality_checks c ON c.organization_id=q.organization_id AND c.id=q.quality_check_id AND c.work_order_id=b.work_order_id WHERE b.id IS NULL OR (q.quality_check_id IS NOT NULL AND c.id IS NULL)`],
    ['MES finished goods inventory references', `SELECT i.id FROM mes_finished_goods_inventory i LEFT JOIN mes_finished_goods_batches b ON b.organization_id=i.organization_id AND b.id=i.batch_id WHERE b.id IS NULL`],
    ['MES finished goods receipt references', `SELECT r.id FROM mes_finished_goods_receipts r LEFT JOIN mes_finished_goods_batches b ON b.organization_id=r.organization_id AND b.id=r.batch_id WHERE b.id IS NULL`],
    ['MES finished goods resolution references', `SELECT r.id FROM mes_finished_goods_resolutions r LEFT JOIN mes_finished_goods_batches b ON b.organization_id=r.organization_id AND b.id=r.batch_id WHERE b.id IS NULL OR b.quantity<>r.quantity`],
    ['MES membership references', `SELECT m.id FROM memberships m LEFT JOIN organizations o ON o.id=m.organization_id LEFT JOIN users u ON u.id=m.user_id WHERE o.id IS NULL OR u.id IS NULL`],
    ['MES audit actor references', `SELECT a.id FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE u.id IS NULL`],
  ];
  for (const [label, sql] of checks) {
    const row = db.prepare(sql).get();
    if (row) throw new Error(`${label} unresolved (first row ${row.id})`);
  }
}

function applyTargetSchema(target) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const migrationDir = path.join(root, 'backend', 'migrations');
  target.exec('CREATE TABLE suite_migrations(name TEXT PRIMARY KEY)');
  for (const file of ['mes_initial.sql', 'mes_guards.sql', '0004_station_identity.sql', '0005_traffic_lab.sql', '0006_mes_finished_goods.sql', '0007_mes_finished_goods_resolutions.sql']) {
    target.exec(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
  }
  // Projection triggers and the initial work-order outbox backfill are installed
  // after importing rows, so no source delivery state is replayed.
}

export function migrate(sourcePath, destinationPath, organizationIds, { afterSnapshot, outboxReconciliation, legacyReportMappings } = {}) {
  if (!Array.isArray(organizationIds) || organizationIds.length === 0 || organizationIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error('Specify one or more exact --organization IDs; wildcard migration is disabled');
  }
  const selectedOrgIds = [...new Set(organizationIds)].sort();
  const sourceFile = path.resolve(sourcePath), destinationFile = path.resolve(destinationPath);
  if (sourceFile === destinationFile) throw new Error('Source and destination must differ');
  if (!fs.statSync(sourceFile).isFile() || !fs.statSync(path.dirname(destinationFile)).isDirectory()) throw new Error('Source file and destination parent directory are required');
  let source, backup, target;
  const nonce = randomBytes(16).toString('hex');
  const privateDir = fs.mkdtempSync(path.join(path.dirname(destinationFile), `.mes-migration-${nonce}-`));
  try { fs.chmodSync(privateDir, 0o700); } catch {}
  const backupPath = path.join(privateDir, 'source-snapshot.sqlite');
  const stagingPath = path.join(privateDir, 'mes-target.sqlite');
  try {
    source = new DatabaseSync(sourceFile, { readOnly: true });
    const sourceVersion = source.prepare('PRAGMA data_version').get().data_version;
    assertSource(source);
    const before = manifestSnapshot(source);
    source.exec(`VACUUM INTO ${sqlLiteral(backupPath)}`);
    backup = new DatabaseSync(backupPath, { readOnly: true });
    const sourceTables = assertSource(backup);
    if (manifestSnapshot(backup) !== before) throw new Error('Consistent backup content does not match source snapshot');
    // All migration decisions after this point must use the immutable snapshot.
    // The optional callback is only used by synthetic tests to simulate a
    // concurrent source change and prove that decisions do not drift to source.
    afterSnapshot?.();
    const archivePlan = checkOutbox(backup, outboxReconciliation, sourceFile, destinationFile);

    const marks = selectedOrgIds.map(() => '?').join(',');
    const existing = new Set(backup.prepare(`SELECT id FROM organizations WHERE id IN (${marks})`).all(...selectedOrgIds).map(row => row.id));
    const missing = selectedOrgIds.filter(id => !existing.has(id));
    if (missing.length) throw new Error(`Selected organization not found: ${missing.join(', ')}`);
    const businessOrgIds = new Set();
    for (const table of MES_TABLES) {
      if (!sourceTables.has(table)) continue;
      for (const row of backup.prepare(`SELECT DISTINCT organization_id FROM ${q(table)} WHERE organization_id IN (${marks})`).all(...selectedOrgIds)) businessOrgIds.add(row.organization_id);
    }
    for (const row of backup.prepare(`SELECT DISTINCT a.organization_id FROM station_grants g JOIN station_accounts a ON a.user_id=g.user_id WHERE g.site='mes' AND a.organization_id IN (${marks})`).all(...selectedOrgIds)) businessOrgIds.add(row.organization_id);
    const noMes = selectedOrgIds.filter(id => !businessOrgIds.has(id));
    if (noMes.length) throw new Error(`Selected tenant has no MES business data or MES identity grant: ${noMes.join(', ')}`);
    const convertedRetries = convertLegacyReportRetries(backup, selectedOrgIds, legacyReportMappings);
    const mappedOrgs = new Set(backup.prepare(`
      SELECT DISTINCT a.organization_id FROM station_accounts a
      JOIN station_grants g ON a.user_id=g.user_id AND g.site='mes'
      WHERE a.organization_id IN (${marks}) AND a.disabled=0 AND g.enabled=1
        AND length(trim(a.password_hash))>0
    `).all(...selectedOrgIds).map(row => row.organization_id));
    if (selectedOrgIds.some(id => !mappedOrgs.has(id))) {
      throw new Error('Selected tenant is missing a usable MES station account and grant mapping');
    }

    const users = identityPlan(backup, selectedOrgIds);
    const fd = fs.openSync(stagingPath, 'wx', 0o600); fs.closeSync(fd);
    target = new DatabaseSync(stagingPath);
    applyTargetSchema(target);
    target.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    const copied = {};
    const orgWhere = `id IN (${marks})`;
    copied.organizations = copyRows(backup, target, 'organizations', orgWhere, selectedOrgIds);
    if (users.length) copied.users = copyRows(backup, target, 'users', `id IN (${users.map(() => '?').join(',')})`, users);
    else copied.users = 0;
    copied.memberships = copyRows(backup, target, 'memberships', `organization_id IN (${marks})`, selectedOrgIds);
    for (const table of MES_TABLES) {
      copied[table] = sourceTables.has(table)
        ? copyRows(backup, target, table, `organization_id IN (${marks})`, selectedOrgIds)
        : 0;
    }
    copied.audit_events = copyRows(backup, target, 'audit_events', `organization_id IN (${marks}) AND ${mesAudit}`, selectedOrgIds);
    copied.station_accounts = copyRows(backup, target, 'station_accounts', `organization_id IN (${marks})`, selectedOrgIds);
    const accountIds = copied.station_accounts
      ? target.prepare(`SELECT user_id FROM station_accounts WHERE organization_id IN (${marks})`).all(...selectedOrgIds).map(row => row.user_id)
      : [];
    copied.station_grants = accountIds.length
      ? copyRows(backup, target, 'station_grants', `site='mes' AND user_id IN (${accountIds.map(() => '?').join(',')})`, accountIds)
      : 0;
    // MES report retry state is durable business state: dropping it could let a
    // client retry create a second production report after cutover. Copy only
    // the known MES endpoint keys for selected tenants, and require each key to
    // match an imported report. Other stations' keys remain excluded.
    const mesKeys = backup.prepare(`SELECT id,organization_id,key,endpoint,request_hash,response_status,response_body FROM idempotency_keys WHERE organization_id IN (${marks}) AND endpoint='/station/mes/report' ORDER BY id`).all(...selectedOrgIds);
    for (const row of mesKeys) {
      const report = backup.prepare('SELECT id FROM mes_production_reports WHERE organization_id=? AND idempotency_key=?').get(row.organization_id, row.key);
      if (!report || row.response_status !== 200 || !row.request_hash || !row.response_body) throw new Error(`Unverifiable MES retry key for ${row.organization_id}; reconcile before migration`);
      let response;
      try { response = JSON.parse(row.response_body); } catch { throw new Error(`Invalid stored MES retry response for ${row.organization_id}`); }
      if (response?.reportId !== report.id) throw new Error(`MES retry response does not match report ${report.id}`);
    }
    copied.idempotency_keys = copyRows(backup, target, 'idempotency_keys', `organization_id IN (${marks}) AND endpoint='/station/mes/report'`, selectedOrgIds);
    if (convertedRetries.length) {
      const insertRetry = target.prepare(`INSERT INTO idempotency_keys
        (id,organization_id,key,endpoint,request_hash,response_status,response_body) VALUES(?,?,?,?,?,200,?)`);
      for (const retry of convertedRetries) {
        insertRetry.run(retry.id, retry.organizationId, retry.key, retry.endpoint, retry.fingerprint, retry.response);
      }
      copied.idempotency_keys += convertedRetries.length;
    }
    // Keep the MES mark, account hashes, and verified MES retry state; never
    // copy live sessions, lockouts, unrelated grants, or non-MES keys.
    target.exec('PRAGMA foreign_keys=ON');
    const violations = target.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error(`Destination foreign key check failed (${violations.length} rows)`);
    assertMesReferences(target);
    // Install projection schema after base data; this creates fresh MES
    // backfill events for work orders, with no source outbox delivery state.
    target.exec(fs.readFileSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'backend', 'migrations', '0003_mes_projection.sql'), 'utf8'));
    target.exec('CREATE TABLE mes_repository_schema (version INTEGER NOT NULL); INSERT INTO mes_repository_schema(version) VALUES (1)');
    const targetTables = tables(target);
    for (const table of RESET_TABLES) if (count(target, table) !== 0) throw new Error(`Reset-only table unexpectedly populated: ${table}`);
    for (const table of EXCLUDED_PREFIXES) {
      if ([...targetTables].some(name => name.startsWith(table))) throw new Error(`Excluded domain table present in target: ${table}`);
    }
    target.exec('COMMIT');
    assertIntegrity(target, 'Destination');
    const targetCounts = Object.fromEntries([...COPY_TABLES].map(table => [table, count(target, table)]));
    target.close(); target = undefined;
    backup.close(); backup = undefined;
    const syncFd = fs.openSync(stagingPath, 'r+');
    try { fs.fsyncSync(syncFd); } finally { fs.closeSync(syncFd); }
    function requireUnchangedSource() {
      if (source.prepare('PRAGMA data_version').get().data_version !== sourceVersion) {
        throw new Error('Source changed after the migration snapshot was created');
      }
    }
    requireUnchangedSource();
    if (fs.existsSync(destinationFile)) throw new Error('Destination already exists');
    const retainedArchive = archivePlan ? publishArchive(backupPath, archivePlan) : undefined;
    requireUnchangedSource();
    // Atomic no-clobber publication. linkSync fails if destination already exists.
    fs.linkSync(stagingPath, destinationFile);
    return { source: sourceFile, destination: destinationFile, organizationIds: selectedOrgIds, sourceSnapshotContentSha256: before, copiedRows: copied, targetRows: targetCounts, resetTables: RESET_TABLES, rebuiltTables: REBUILT_TABLES, sessionsCopied: false, outboxReconciliation: retainedArchive, convertedLegacyReportRetries: convertedRetries.length };
  } finally {
    target?.close(); backup?.close(); source?.close();
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
}

function cli(args) {
  if (args.length < 4 || args[0] !== '--source' || args[2] !== '--destination') {
    throw new Error('Usage: node scripts/migrate-mes-go-db.mjs --source OLD.sqlite --destination NEW.sqlite --organization ORG_ID [--organization ORG_ID ...] [--reviewed-outbox-archive ARCHIVE.sqlite] [--reviewed-report-mapping MAPPINGS.json]');
  }
  const source = args[1], destination = args[3];
  const organizations = [];
  let outboxReconciliation;
  let legacyReportMappings;
  for (let i = 4; i < args.length; i++) {
    if (args[i] === '--organization' && args[i + 1]) organizations.push(args[++i]);
    else if (args[i] === '--reviewed-outbox-archive' && args[i + 1] && !outboxReconciliation) {
      outboxReconciliation = { reviewed: true, archivePath: args[++i] };
    } else if (args[i] === '--reviewed-report-mapping' && args[i + 1] && legacyReportMappings === undefined) {
      try {
        legacyReportMappings = JSON.parse(fs.readFileSync(args[++i], 'utf8'));
      } catch {
        throw new Error('Cannot read the reviewed MES report mapping');
      }
      if (!Array.isArray(legacyReportMappings)) throw new Error('Reviewed MES report mapping must be a JSON array');
    } else throw new Error(`Unexpected argument: ${args[i]}`);
  }
  return migrate(source, destination, organizations, { outboxReconciliation, legacyReportMappings });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(cli(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`Migration refused: ${error.message}`); process.exitCode = 2; }
}
