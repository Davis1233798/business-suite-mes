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
- `scripts/migrate-mes-go-db.mjs` is an offline importer from the shared Go
  SQLite database into a new MES-only Go SQLite database. It accepts only the
  shared Go migration markers `0003_mes_projection`,
  `0006_mes_finished_goods`, and
  `0007_mes_finished_goods_resolutions`; it does not convert Vinext data,
  SQLCipher files, or Cloudflare D1 databases.
- The importer requires explicit organization IDs, a new destination, and zero
  rows in the source `outbox_events` table. It snapshots the source read-only,
  validates the snapshot, copies selected organizations and needed users,
  memberships, MES audit events, station accounts/MES grants, MES business
  tables, and verified MES report idempotency keys. It omits sessions and
  unrelated domains, rebuilds projection state, and refuses populated
  MES/ERP mapping tables, unknown MES-prefixed tables, unsupported migration
  markers or column layouts, or unresolved references. Unrelated domain tables
  are excluded rather than copied into the target.

These are source-code and schema capabilities. They do not prove that a
production migration or service/database cutover has taken place.

## Remaining live-cutover work

- Define and implement the Vinext-to-MES conversion contract: inventory the
  actual source schema and encryption format, map records and identity/tenant
  ownership, define handling for unsupported or ambiguous rows, and validate
  counts, references, audit history, idempotency, and business invariants.
- Reconcile source outbox/integration work and settle the selected organization
  set against authoritative production records. The importer currently blocks
  on any source outbox row; no reconciliation/bypass procedure is implemented.
- Prepare a production runbook with writer freeze, independently verified
  backups, staged import, dry reconciliation, downtime/consistency checks,
  application configuration and routing steps, and an explicit rollback owner
  and rollback data policy for writes accepted after cutover.
- Execute and record a staged migration against a representative, authorized
  data copy, then execute the approved live migration and reconcile source and
  target evidence. No actual business-data migration, staged rehearsal, or
  production database cutover is evidenced by this repository change.
- If Vinext/Cloudflare remains an intended runtime, specify and implement the
  D1 import/export path and prove its schema/data parity independently. The
  Go SQLite importer does not provide this path.

Until that evidence exists, describe the state as “MES Go finished-goods
workflow implemented; shared Go SQLite importer implemented with a narrow
allowlist; Vinext conversion and live migration/cutover pending.” Do not claim
that a live database migration, D1/SQLCipher conversion, or production route
cutover is complete based on schema files, importer code, or synthetic CI
fixtures alone.
