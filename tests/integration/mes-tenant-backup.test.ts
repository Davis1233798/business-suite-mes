import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1 } from '../../lib/db/sqlite-d1.ts';
import { setCustomD1 } from '../../db/index.ts';
import { exportWorkspace, exportWorkspaceCsv, restoreWorkspace, validateWorkspaceBackup } from '../../lib/tenant-backup.ts';
import type { TenantContext } from '../../lib/tenant.ts';

const context:TenantContext={organizationId:'org_mes_test',userId:'admin_test',userEmail:'admin@example.test',userDisplayName:'Admin',role:'admin',requestId:'backup-test'};

test('MES backup, restore and CSV operate only on MES tables', async () => {
 const d1=createSqliteD1(); setCustomD1(d1);
 try {
  d1._rawDb.prepare("INSERT INTO mes_products(id,organization_id,sku,name,unit,status) VALUES(?,?,?,?,?,?)").run('mes-p1',context.organizationId,'SKU-1','Example','PCS','active');
  const snapshot=await exportWorkspace(context);
  const names=Object.keys(snapshot.tables);
  assert.ok(names.length>0);assert.ok(names.every(name=>name.startsWith('mes_')));
  assert.equal(snapshot.tables.mes_products.length,1);
  const csv=await exportWorkspaceCsv(context,'mes_products');assert.match(csv,/SKU-1/);
  await assert.rejects(()=>exportWorkspaceCsv(context,'erp_items'));
  d1._rawDb.prepare("DELETE FROM mes_products WHERE id=?").run('mes-p1');
  await restoreWorkspace(context,snapshot);
  assert.equal(d1._rawDb.prepare("SELECT count(*) AS n FROM mes_products WHERE id='mes-p1'").get().n,1);
  assert.throws(()=>validateWorkspaceBackup(context,{...snapshot,tables:{...snapshot.tables,erp_items:[]}}));
 } finally { d1._rawDb.close(); }
});
