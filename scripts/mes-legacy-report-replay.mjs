import { createHash } from 'node:crypto';

const legacyEndpoint = '/api/mes/report';
const nativeEndpoint = '/station/mes/report';
const actorKey = (organization, user) => JSON.stringify([organization, user]);
const quantity = value => Number.isSafeInteger(value) && value >= 0;
const boundedText = (value, minimum, maximum) =>
  typeof value === 'string' && Buffer.byteLength(value) >= minimum && Buffer.byteLength(value) <= maximum;

export function convertLegacyReportRetries(source, organizationIds, mappings) {
  const marks = organizationIds.map(() => '?').join(',');
  const rows = source.prepare(`
    SELECT id, organization_id, key, request_hash, response_status, response_body
    FROM idempotency_keys WHERE organization_id IN (${marks}) AND endpoint=? ORDER BY id
  `).all(...organizationIds, legacyEndpoint);
  if (!rows.length) return [];
  if (!Array.isArray(mappings) || !mappings.length) {
    throw new Error('Source MES report retry requires reviewed identity and response mapping');
  }
  const selected = new Set(organizationIds);
  const actors = new Set();
  const account = source.prepare(`
    SELECT 1 FROM station_accounts a JOIN station_grants g ON g.user_id=a.user_id
    WHERE a.organization_id=? AND a.user_id=? AND a.disabled=0 AND length(trim(a.password_hash))>0
      AND g.site='mes' AND g.enabled=1 AND g.role IN ('admin','operator') AND g.scope IN ('front','back')
  `);
  for (const entry of mappings) {
    if (!entry || !selected.has(entry.organizationId) || !boundedText(entry.legacyOperatorId, 1, 256) ||
        entry.stationUserId !== entry.legacyOperatorId ||
        !account.get(entry.organizationId, entry.stationUserId)) {
      throw new Error('Reviewed MES report retry mapping requires a same-tenant enrolled writer preserving the actor ID');
    }
    const key = actorKey(entry.organizationId, entry.legacyOperatorId);
    if (actors.has(key)) throw new Error('Duplicate reviewed MES report retry actor mapping');
    actors.add(key);
  }

  const committedReports = source.prepare(`
    SELECT r.*, w.target_quantity, w.completed_quantity, w.scrapped_quantity
    FROM mes_production_reports r
    JOIN mes_work_orders w ON w.organization_id=r.organization_id AND w.id=r.work_order_id
    JOIN mes_operations o ON o.organization_id=r.organization_id AND o.id=r.operation_id AND o.work_order_id=w.id
    WHERE r.organization_id=? AND r.idempotency_key=? LIMIT 2
  `);
  const nativeKey = source.prepare("SELECT 1 FROM idempotency_keys WHERE organization_id=? AND key=? AND endpoint=?");
  return rows.map(row => {
    if (!boundedText(row.key, 8, 128) || row.request_hash !== row.key || row.response_status !== 200) {
      throw new Error('Unverifiable legacy MES report retry key');
    }
    if (nativeKey.get(row.organization_id, row.key, nativeEndpoint)) {
      throw new Error('Legacy MES report retry conflicts with an existing native retry key');
    }
    const matches = committedReports.all(row.organization_id, row.key);
    if (matches.length !== 1) throw new Error('Legacy MES report retry must identify one committed report');
    const report = matches[0];
    if (!actors.has(actorKey(row.organization_id, report.operator_id))) {
      throw new Error('Legacy MES report retry actor has no reviewed station mapping');
    }
    let cached;
    try { cached = JSON.parse(row.response_body); } catch { throw new Error('Invalid legacy MES retry response'); }
    const notes = report.notes ?? '';
    if (!cached || cached.success === false || cached.reportId !== report.id ||
        cached.goodQuantity !== report.good_quantity || cached.scrapQuantity !== report.scrap_quantity ||
        ![report.good_quantity, report.scrap_quantity, report.target_quantity, report.completed_quantity, report.scrapped_quantity, cached.totalCompleted, cached.totalScrapped].every(quantity) ||
        report.good_quantity > 1000000 || report.scrap_quantity > 1000000 || report.good_quantity + report.scrap_quantity === 0 ||
        cached.totalCompleted < report.good_quantity || cached.totalScrapped < report.scrap_quantity ||
        cached.totalCompleted > report.completed_quantity || cached.totalScrapped > report.scrapped_quantity ||
        cached.totalCompleted + cached.totalScrapped > report.target_quantity ||
        cached.orderStatus !== (cached.totalCompleted + cached.totalScrapped === report.target_quantity ? 'completed' : 'in_progress') ||
        !boundedText(report.work_order_id, 1, 256) || !boundedText(report.operation_id, 1, 256) || !boundedText(notes, 0, 500)) {
      throw new Error('Legacy MES retry report mismatch in cached quantities or response');
    }
    const command = {
      action: 'report', workOrderId: report.work_order_id, operationId: report.operation_id,
      goodQuantity: report.good_quantity, scrapQuantity: report.scrap_quantity, notes, idempotencyKey: row.key,
    };
    // Match Go encoding/json's default escaping for the native request fingerprint.
    const serialized = JSON.stringify(command).replace(/[<>&\u2028\u2029]/g, char =>
      '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    return {
      id: row.id, organizationId: row.organization_id, key: row.key, endpoint: nativeEndpoint,
      fingerprint: createHash('sha256').update(report.operator_id + '\0' + serialized).digest('hex'),
      response: JSON.stringify({
        workOrderId: report.work_order_id, reportId: report.id,
        goodQuantity: report.good_quantity, scrapQuantity: report.scrap_quantity,
        totalCompleted: cached.totalCompleted, totalScrapped: cached.totalScrapped, status: cached.orderStatus,
      }),
    };
  });
}
