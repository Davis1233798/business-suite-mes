# Shared Go SQLite to MES-only database migration

Status: offline importer and synthetic acceptance suite are implemented. They
are not production-certified. Do not run against a live/shared database or
switch `SUITE_DB` based only on this document; wait for CI and review.

## Source and target boundary

The source is the shared Go SQLite database from Portfolio. Keep every writer
stopped from the final backup through database-path cutover: writes after the
snapshot are not included and would otherwise be missing from the MES target.
It is identified by
`suite_migrations` containing `0003_mes_projection`; only
`0003_mes_projection`, `0006_mes_finished_goods`, and
`0007_mes_finished_goods_resolutions` are supported. The shared database does
not use the standalone MES repo's `mes_repository_schema` marker. The source is
opened read-only and snapshotted with SQLite `VACUUM INTO`. All post-snapshot
tenant and identity decisions use the verified snapshot, not the live source.
The original file is never modified. The output must be a new path whose
parent exists. The target schema comes from this MES repository's migrations
and receives its own `mes_repository_schema` marker.

## Table contract

| Action | Tables | Policy |
| --- | --- | --- |
| Copy | `organizations`, `mes_products`, `mes_bom_versions`, `mes_bom_items`, `mes_work_centers`, `mes_work_orders`, `mes_operations`, `mes_material_lots`, `mes_work_order_materials`, `mes_production_reports`, `mes_quality_checks`, `mes_downtime_events`, `mes_finished_goods_batches`, `mes_finished_goods_quality_dispositions`, `mes_finished_goods_inventory`, `mes_finished_goods_receipts`, `mes_finished_goods_resolutions` | Preserve IDs and rows for explicitly selected organizations; validate same-tenant work-order, report, batch, product, and user references. |
| Filter and copy | `users`, `memberships`, `station_accounts`, `station_grants`, `audit_events` | Copy only identities needed by selected MES tenants, only `site='mes'` grants, and only `action LIKE 'mes.%'` audit rows. Preserve selected account password hashes. Reject identities also linked to unselected tenants. |
| Reset | `station_sessions`, `station_login_limits`, `demo_seed_states`, `traffic_runs`, `traffic_records` | Do not copy ephemeral sessions, lockouts, demo, or traffic records. |
| Scoped replay state | `idempotency_keys` | Preserve selected-tenant `/station/mes/report` entries only when each matches an imported production report, successful status, and parseable response naming that report. Other station keys are excluded. Unverifiable MES replay state fails closed. |
| Rebuild | `outbox_events`, `suite_migrations`, `mes_projection_revisions` | Any source outbox row blocks migration. Install projection triggers after import and rebuild projection events from work orders; do not copy delivery state. |
| Exclude | All other tables, including `erp_*`, `pos_*`, `crm_*`, `dining_*`, `shop_*`, plus `mes_erp_product_mappings` and `erp_mes_receipt_postings` | MES/ERP integration tables may be present only when empty. Any mapping or receipt-posting rows cause refusal because their ERP references cannot be preserved in an MES-only database. Unknown MES tables or migration markers also cause refusal. |

Finished-goods schema from profolio migrations `0006` and `0007` is included in
the independent MES Go target. The latest profolio `0008`/`0009` MES/ERP model is
cross-station state and is not copied. Application-level checks supplement
`PRAGMA foreign_key_check`, since older MES core tables have few declared FKs.

## Importer safety properties

The importer requires explicit `--organization` IDs; wildcard import is
disabled. It validates source schema and integrity, verifies a consistent
private snapshot inside a mode-0700 temporary directory, creates an unseeded
target schema in a new staging file,
copies the allowlisted rows inside a transaction, and compares rows and counts.
It checks tenant-scoped references, session reset, FK and integrity checks,
then adds the MES marker and fsyncs the staged database. A hard link publishes
the complete file only if the destination still does not exist. Failures leave
the source and any preexisting destination unchanged and clean up staging files.

Command for a stopped, backed-up source and new destination path:

```powershell
node scripts/migrate-mes-go-db.mjs --source C:\path\shared.sqlite --destination C:\path\mes-new.sqlite --organization ORG_ID
node --test tests/migration/mes-go-db.test.mjs
```

The command emits table counts and a source content hash, never row contents.
It rejects any source outbox rows, unresolved business or identity references,
unknown MES migrations/tables, populated MES/ERP mappings, and identity reuse
across selected/unselected tenants.

## CI fixture and limits

CI creates only disposable SQLite files from shared multi-station Go
migrations `0000` through `0009`, including synthetic finished-goods records
and empty MES/ERP integration tables. Cases cover selected-tenant copying,
account hashes, MES-only grants and audit, session reset, rebuilt projection,
non-MES exclusion, no-clobber destinations, unresolved references, outbox
refusal, cross-tenant identity refusal, cross-station mapping refusal,
unsupported markers, and mutation of the live source after snapshot creation.
No local tests are run during this change.

Passing CI will establish only the synthetic path. It will not certify actual
source data, a complete application workflow, production downtime, deployment,
or rollback after MES has accepted new writes. The MES Go server currently has
the imported finished-goods schema but its independent repository has not yet
ported the profolio finished-goods HTTP handlers/UI; data is preserved but that
workflow is not yet usable through the target app. MES Go and Vinext SQLite
remain separate files; D1 export/import and cross-system ERP integration
migration are outside this procedure. Before production, review exact source inventory,
selected organizations, outbox reconciliation, backups, and rollback ownership.
