# Shared Go SQLite to MES-only database migration

Status: offline importer and synthetic acceptance suite are implemented. The
tool is not production-certified; do not run it against a live/shared database
or switch `SUITE_DB` based only on this document. CI is the required first
execution evidence.

## Source and target boundary

The source is the shared Go SQLite database from the Portfolio repository. It
is recognized through `suite_migrations` containing exactly the supported
`0003_mes_projection` marker; the shared Go DB does not use the standalone MES
repository's `mes_repository_schema` marker. It must be opened read-only and
snapshotted with SQLite `VACUUM INTO` while all writers are stopped. The
original file is never modified. The output must be a new, exclusively-created
path. Never overwrite, rename over, or initialize a nonempty destination. The
destination gets this MES repository's migrations and `mes_repository_schema`
marker, not a marker copied from the source.

## Explicit table contract

| Action | Tables | Policy |
| --- | --- | --- |
| Copy | `organizations`, `mes_products`, `mes_bom_versions`, `mes_bom_items`, `mes_work_centers`, `mes_work_orders`, `mes_operations`, `mes_material_lots`, `mes_work_order_materials`, `mes_production_reports`, `mes_quality_checks`, `mes_downtime_events` | Preserve tenant IDs and primary keys for explicitly selected organizations. |
| Copy with filtering | `users`, `memberships`, `station_accounts`, `station_grants`, `audit_events` | Keep only identities referenced by retained MES memberships, MES actions, MES reporters/inspectors/operators, or accounts for selected organizations. Keep only `site='mes'` grants and `action LIKE 'mes.%'` audit history. Password hashes are retained for selected MES accounts; cross-tenant account/membership reuse fails closed. |
| Recreate empty | `station_sessions`, `station_login_limits`, `idempotency_keys`, `demo_seed_states`, `traffic_runs`, `traffic_records` | Sessions, rate limits, idempotency and demo/traffic state are reset. No sessions are copied. |
| Rebuild | `outbox_events`, `suite_migrations`, `mes_projection_revisions` | Any source outbox row blocks migration. MES projection schema/backfill is created from imported work orders; source delivery state is not copied. |
| Exclude | Every other table, including all `erp_*`, `pos_*`, `crm_*`, `dining_*`, and `shop_*` tables | Never copy. Resolve all source outbox rows first; silently dropping another station's events could lose work. |

The importer pins a reviewed list against the repository migrations. It refuses
shared DB ledgers with migrations beyond the supported projection-only version
and refuses unknown `mes_*` tables. The latest profolio main has added MES
finished-goods and MES/ERP integration tables/migrations; it therefore fails
closed until the target repo adopts and validates those schemas. Existing Go
migrations define few foreign keys for MES business tables, so application-level
tenant/reference checks supplement `PRAGMA foreign_key_check`.

## Required importer properties

1. Validate source marker/version and integrity, list all tables/counts, and
   reject unknown schema versions or missing expected tables.
2. Create a consistent private backup without write access to source. Emit the
   content snapshot hash and per-table copied/target counts without row contents
   or credentials.
3. Build target schema in a staging file beside the target, then transactionally
   copy the exact allowlisted tables with tenant/account filtering.
4. Before commit, verify tenant membership, cross-table references, row counts,
   per-row equality (including NULL/blob handling), and FK checks. Assert no
   excluded station data was copied and no unauthorized grants remain.
5. Verify destination integrity, add the MES marker last, close/fsync the staged
   database, and
   atomically publish only if the final destination path still does not exist.
   Any failure removes staging files and leaves source and preexisting targets
   byte-for-byte unchanged.
6. Require stopped writers for cutover. Keep source as rollback copy; on
   rollback, stop MES writers and restore the old `SUITE_DB` setting. There is
   no safe reverse merge after MES accepts writes unless a separately designed
   delta protocol exists.

## Offline command and acceptance suite

Use a stopped, backed-up source and a new destination path on the same
filesystem. Select tenants explicitly; wildcard import is disabled:

```powershell
node scripts/migrate-mes-go-db.mjs --source C:\path\shared.sqlite --destination C:\path\mes-new.sqlite --organization ORG_ID
node --test tests/migration/mes-go-db.test.mjs
```

The command performs a read-only source open, creates and verifies a consistent
private snapshot, writes only an exclusive staging file, then atomically
hard-links the complete target into a previously absent destination. It emits
counts and a content snapshot hash, not row contents. Any source outbox events,
unresolved references, unknown MES tables, unsupported markers, and identities
also belonging to unselected tenants cause refusal. Target schema is bootstrapped
from this repo's Go migrations without demo seeds.

Tests use only generated disposable databases bootstrapped from the same
shared multi-station Go base migrations (`0000` through `0005`) as Portfolio,
with the projection ledger rather than an independent-MES marker. Current
synthetic cases cover
tenant filtering, account hashes, MES-only grants/audit, session reset, rebuilt
projection events, non-MES exclusion, existing destination protection,
unresolved references, outbox refusal, cross-tenant identity refusal, and
unsupported markers. Additional CI coverage should include missing tables,
schema mismatch, and Go startup/business write-read against the imported target.
Tests assert source bytes and existing destination remain unchanged on covered
failure paths. Tests must never use
`.data`, `.wrangler`, a configured hosting database, or a production URL.

## Known gap

The existing Portfolio `scripts/migrate-legacy-sqlite.py` is a Node/Vinext
site-schema importer. It does not import Go data or move D1 data. MES Go and
Vinext have separate SQLite files. The importer intentionally targets the Go
database only and its base schema has no demo seed inserts. D1 requires a
separate export/import plan and is outside this migration. CI has not yet
executed for this change; passing CI still does not certify production data,
full application workflows, downtime, or rollback after new MES writes.
