# MES cutover parity and evidence boundary

## Implemented in the MES Go repository

- The independent MES Go service owns an SQLite schema. Its migrations
  `0006_mes_finished_goods.sql` and
  `0007_mes_finished_goods_resolutions.sql` provide finished-goods batch,
  disposition, inventory, receipt, and resolution tables.
- `backend/mes_finished_goods.go` implements the finished-goods API workflow;
  `web/src/MesFinishedGoods.tsx` and `web/src/mesFinishedGoodsView.ts` provide
  the React view and its projection helpers. `web/src/main.tsx` imports and
  renders the view in the MES back office. The feature contract and local
  ownership boundary are described in `MES_FINISHED_GOODS.md`.
- `scripts/migrate-mes-go-db.mjs` is an offline importer from a shared
  portfolio SQLite schema into a new MES-only Go SQLite database. Compatibility
  must be determined from the observed database engine, schema, migration
  markers, identities, and records, not the web framework name. The observed
  production candidate was written by Node v24.22.2 `node:sqlite` (SQLite
  3.53.4); a Python 3.45.1 SQLite library was used only as the metadata reader.
  Its schema has only the `0003_mes_projection` ledger marker and omits all
  five finished-goods tables/markers. The current importer does not yet accept
  this source variant.
- The importer requires explicit organization IDs and a new destination. It
  currently refuses every source outbox row, requires finished-goods tables,
  filters audits using lowercase `action LIKE 'mes.%'`, and does not fail when
  selected organizations lack a Go MES account/grant. Those current limits do
  not match the observed source: 5,720 outbox rows, all processed; eight
  `MES_START`/`mes` audit rows; and zero station accounts/grants/sessions. A
  test-first branch specifies a reviewed archive/reconciliation mode for only
  fully processed history, schema-shape acceptance for the all-absent finished
  goods variant, scoped audit preservation, and fail-closed identity enrollment.
  These changes are not implemented or production-approved by the test/docs
  branch. The importer must also refuse the observed `/api/mes/report` retry
  contract until request, response, and identity semantics are explicitly
  reconciled with Go's `/station/mes/report` fingerprint contract.

These are source-code and schema capabilities. They do not prove that a
production migration or service/database cutover has taken place.

## Remaining live-cutover work

- Complete and review the migration contract for the observed shared portfolio
  SQLite schema, including source/target schema variants, tenant ownership,
  audit history, identity enrollment, report retry state, and business
  invariants. Metadata counts do not establish row-level business validity.
- Reconcile source outbox/integration history and settle the selected
  organization set against authoritative production records. Every observed
  source outbox row is processed, but history must remain in a verified archive
  with counts/digests and must never be replayed into external integrations.
- Prepare a production runbook with writer freeze, independently verified
  backups, staged import, dry reconciliation, downtime/consistency checks,
  application configuration and routing steps, and an explicit rollback owner
  and rollback data policy for writes accepted after cutover.
- Execute and record a staged migration against a representative, authorized
  data copy, then execute the approved live migration and reconcile source and
  target evidence. No actual business-data migration, staged rehearsal, or
  production database cutover is evidenced by this repository change.
- If any intended source uses a different persistence engine such as Cloudflare
  D1 or SQLCipher, specify and implement that source adapter separately and
  prove schema/data parity independently. The shared Node SQLite candidate is
  not a D1/SQLCipher database.

Until that evidence exists, describe the state as “MES Go finished-goods
workflow implemented; shared portfolio SQLite importer implemented with a
narrow allowlist; observed-source conversion, identity mapping, and live
migration/cutover pending.” Do not claim
that a live database migration, D1/SQLCipher conversion, or production route
cutover is complete based on schema files, importer code, or synthetic CI
fixtures alone.
