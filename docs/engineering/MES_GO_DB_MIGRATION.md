# Shared Go SQLite to MES-only database migration

Status: design and acceptance contract only. No importer exists yet. Do not point
this procedure at a live database or switch `SUITE_DB` based on this document.

## Source and target boundary

The source is the shared Go SQLite database from the Portfolio repository. It
must be opened read-only and snapshotted with SQLite's backup API (or
`VACUUM INTO`) while all writers are stopped. The original file is never
modified. The output must be a new, exclusively-created path. Never overwrite,
rename over, or initialize a nonempty destination. The destination gets the
MES repository's own migrations and `mes_repository_schema` marker, not a
marker copied from the source.

## Explicit table contract

| Action | Tables | Policy |
| --- | --- | --- |
| Copy | `organizations`, `mes_products`, `mes_bom_versions`, `mes_bom_items`, `mes_work_centers`, `mes_work_orders`, `mes_operations`, `mes_material_lots`, `mes_work_order_materials`, `mes_production_reports`, `mes_quality_checks`, `mes_downtime_events`, `audit_events` | Preserve tenant IDs and primary keys; copy rows for organizations with MES business data. Preserve audit history only for the selected tenant IDs. |
| Copy with filtering | `users`, `memberships`, `station_accounts`, `station_grants` | Keep only users referenced by retained MES memberships, MES audit actors, MES reporters/inspectors, or accounts in retained organizations. Keep only `site='mes'` grants. Preserve password hashes only for explicitly retained MES accounts; otherwise require credential reset/reprovisioning. |
| Recreate empty | `station_sessions`, `station_login_limits`, `idempotency_keys`, `outbox_events`, `suite_migrations`, `mes_projection_revisions`, `demo_seed_states`, `traffic_runs`, `traffic_records` | Sessions and rate limits are ephemeral. Idempotency keys are only safe to transfer if endpoint semantics and retention are unchanged; default is reset. Outbox is delivery state and must be empty at cutover or explicitly drained/rebuilt. Projection revisions are rebuilt by the MES migrations. Demo and traffic state is not business data. |
| Exclude | Every other table, including all `erp_*`, `pos_*`, `crm_*`, `dining_*`, and `shop_*` tables | Never copy. A nonempty source MES outbox must block migration until its events are resolved; silently dropping it can lose projection updates. |

The actual table dependency list must be generated/reviewed against the exact
source and target migration versions. Existing Go migrations define few foreign
keys for MES business tables, so application-level tenant/reference checks are
also required; `PRAGMA foreign_key_check` alone is insufficient.

## Required importer properties

1. Validate source marker/version and integrity, list all tables/counts, and
   reject unknown schema versions or missing expected tables.
2. Create a consistent private backup without write access to source. Record
   source hash, snapshot hash, schema commit, and per-table counts in a manifest
   that contains no row contents or credentials.
3. Build target schema in a staging file beside the target, then transactionally
   copy the exact allowlisted tables with tenant/account filtering.
4. Before commit, verify tenant membership, cross-table references, row counts,
   per-row equality (including NULL/blob handling), and FK checks. Assert no
   excluded station data was copied and no unauthorized grants remain.
5. Verify destination integrity, add the MES marker last, close/fsync, and
   atomically publish only if the final destination path still does not exist.
   Any failure removes staging files and leaves source and preexisting targets
   byte-for-byte unchanged.
6. Require stopped writers for cutover. Keep source as rollback copy; on
   rollback, stop MES writers and restore the old `SUITE_DB` setting. There is
   no safe reverse merge after MES accepts writes unless a separately designed
   delta protocol exists.

## Acceptance suite to add before enabling the importer

Use only generated disposable databases. Cover MES data and each excluded
station, multiple tenants, shared users with mixed station grants, audit actor
references, null values, pending and delivered outbox states, duplicate IDs,
missing tables, wrong markers, FK/reference violations, and incompatible
columns. Assert the intended row set and exact row equality in the MES target;
assert source bytes and an existing destination remain unchanged on every
failure. Include a successful end-to-end import plus Go startup against the
new target and representative MES start/report/readback. Tests must never use
`.data`, `.wrangler`, a configured hosting database, or a production URL.

## Known gap

The existing Portfolio `scripts/migrate-legacy-sqlite.py` is a Node/Vinext
site-schema importer. It does not import Go data, filter shared identities,
move D1 data, or reconcile business semantics. MES Go and Vinext have separate
SQLite files. The current target bootstrap creates its own demo organization
and accounts, so importer/seed collision behavior must be resolved before a
usable implementation can be accepted. D1 requires a separate export/import
plan and is outside this Go SQLite migration.
