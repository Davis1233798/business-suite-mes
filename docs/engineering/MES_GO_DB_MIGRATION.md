# Shared portfolio SQLite to MES-only database migration

Status: offline importer and synthetic acceptance suite are implemented. They
are not production-certified. Do not run against a live/shared database or
switch `SUITE_DB` based only on this document; wait for CI and review.

## Source and target boundary

The source is a shared portfolio SQLite database, identified by schema and
migration markers rather than by its web framework. The observed production
candidate was written by Node v24.22.2 `node:sqlite` (SQLite 3.53.4); Python's
SQLite 3.45.1 was only the metadata reader and is not the application's engine.
The observed source has `suite_migrations` containing only
`0003_mes_projection`, no `mes_repository_schema`, and 12 operational `mes_*`
tables. It has no finished-goods tables and no `0006` or `0007` migration
markers. The target Go MES schema has five additional finished-goods tables.

The importer must accept that source variant only when all five finished-goods
tables and both finished-goods markers are absent. A partial finished-goods
schema, a marker/table mismatch, an unknown marker, or an unknown MES table
must be rejected before publication. The target still gets all five tables
from this repository's migrations, initially empty. A source with the full
`0006`/`0007` schema remains a separate supported variant after its schema and
data checks pass.

Keep every source writer stopped from the final verified archive through
database-path cutover. The source must be opened read-only, integrity checked,
and copied to a private consistent SQLite snapshot; all post-snapshot tenant,
identity, audit, outbox, and idempotency decisions must use that snapshot. The
original source is never modified. The output must be a new path whose parent
exists. The target schema comes from this repository's migrations and receives
its own `mes_repository_schema` marker.

The observed source is a Node SQLite database, despite its portfolio UI
implementation. The migration boundary is based on the actual table shapes,
`suite_migrations`, record invariants, authentication model, and SQLite engine;
it must not infer incompatibility or compatibility from the framework name.

## Observed source inventory and unresolved boundary

Read-only metadata collected on 2026-11-06 showed 1,550 organizations and
18,632 rows in 12 MES tables. The source `outbox_events` table had 5,720 rows,
all `processed` (5,651 with retry count 0 and 69 with retry count 1). The
source `audit_events` had eight `MES_START` rows with `entity_type='mes'`.
Memberships were evenly grouped at 1,550 each for admin, operator, and
readonly roles.
These counts are an inventory snapshot, not a migration approval or a promise
that the live database has not changed since.

The source had users and memberships, but zero `station_accounts`, zero MES
`station_grants`, and zero station sessions. Source login uses a public demo
session cookie and derives a demo organization/user from that session and a
role cookie. The Go MES login instead authenticates a per-station account and
grant and derives the organization from that account; its demo flow creates a
separate `org_test_…` workspace. Those identities and trust boundaries are not
interchangeable. Copying users/memberships or creating test/demo accounts does
not establish that existing users can access the migrated workspace. Until a
reviewed identity and enrollment mapping exists, fail before publishing a
target. Do not seed passwords, infer ownership from a cookie, or reuse a
private-owner credential in the public demo workspace.

The live source has eight MES production reports, each with a distinct
idempotency key, and eight `/api/mes/report` keys. That API stores
`request_hash` as the key and caches a result object; the route wraps the
result in its HTTP response. The Go `/station/mes/report` handler instead
checks a request fingerprint derived from the authenticated Go user and its
command, then returns a different result contract. A matching key string
alone is not sufficient to replay safely. Until a reviewed request, response,
and identity mapping proves equivalence, fail closed on these source keys; do
not silently omit them or copy them under the Go endpoint.

## Test-first conversion contract

The test-only branch defines the next source-shape and reconciliation contract;
the production importer has not been changed by that work. Tests are expected
to fail against the current implementation for meaningful boundary reasons
until the importer changes are reviewed separately.

- Accept only the known projection-only source shape (`0003` marker, all five
  finished-goods tables absent) and initialize empty target finished-goods
  tables. Reject partial schemas and inconsistent markers before publication.
- Preserve only reviewed MES audit actions/scopes. `MES_START` with
  `entity_type='mes'` is legitimate MES history even though its action does not
  match the current lowercase `mes.%` predicate. Do not broaden this to all
  uppercase or all station actions.
- Never delete, silently ignore, or replay source outbox events. Without an
  explicit reviewed reconciliation option and a new immutable archive path,
  any non-empty outbox blocks migration. Reconciliation may archive only rows
  whose status is exactly `processed`; any pending, failed, or unknown status
  blocks. The retained archive and result manifest must expose row count,
  status counts, canonical outbox content digest, and archive digest. Rebuild
  target projection events from imported work orders; do not replay old
  external integration events.
- Recheck the source content digest immediately before target publication.
  If it differs from the digest verified against the immutable snapshot, fail
  without publishing; a writer freeze is still required operationally.
- Require an independently reviewed identity/enrollment mapping before target
  publication. A user or membership row alone is not a Go login account or
  MES authorization grant.
- Preserve report retry state only when source endpoint, command semantics,
  user/tenant mapping, request fingerprint, successful response, and imported
  report all reconcile. The observed `/api/mes/report` format is not
  interchangeable with `/station/mes/report`; archive and refuse it until a
  tested mapping is approved.

## Table contract

| Action | Tables | Policy |
| --- | --- | --- |
| Copy | `organizations`, `mes_products`, `mes_bom_versions`, `mes_bom_items`, `mes_work_centers`, `mes_work_orders`, `mes_operations`, `mes_material_lots`, `mes_work_order_materials`, `mes_production_reports`, `mes_quality_checks`, `mes_downtime_events`, `mes_finished_goods_batches`, `mes_finished_goods_quality_dispositions`, `mes_finished_goods_inventory`, `mes_finished_goods_receipts`, `mes_finished_goods_resolutions` | Preserve IDs and rows for explicitly selected organizations; validate same-tenant work-order, report, batch, product, and user references. |
| Filter and copy | `users`, `memberships`, `station_accounts`, `station_grants`, `audit_events` | Copy only identities needed by selected MES tenants and only `site='mes'` grants. Audit actions require an explicit reviewed MES action/entity allowlist. Preserve selected account password hashes only after an approved identity mapping. Reject identities also linked to unselected tenants. |
| Reset | `station_sessions`, `station_login_limits`, `demo_seed_states`, `traffic_runs`, `traffic_records` | Do not copy ephemeral sessions, lockouts, demo, or traffic records. |
| Scoped replay state | `idempotency_keys` | Preserve selected-tenant `/station/mes/report` entries only when each matches an imported production report, successful status, and parseable response naming that report. Other station keys are excluded. Unverifiable MES replay state fails closed. |
| Rebuild | `outbox_events`, `suite_migrations`, `mes_projection_revisions` | Source outbox history is retained in a separately verified immutable archive; only an explicit reviewed reconciliation can proceed, and only when every status is `processed`. Never copy or replay old delivery state. Install projection triggers after import and rebuild projection events from work orders. |
| Exclude | All other tables, including `erp_*`, `pos_*`, `crm_*`, `dining_*`, `shop_*`, plus `mes_erp_product_mappings` and `erp_mes_receipt_postings` | MES/ERP integration tables may be present only when empty. Any mapping or receipt-posting rows cause refusal because their ERP references cannot be preserved in an MES-only database. Unknown MES tables or migration markers also cause refusal. |

Finished-goods schema from profolio migrations `0006` and `0007` is included in
the independent MES Go target. The latest profolio `0008`/`0009` MES/ERP model is
cross-station state and is not copied. Application-level checks supplement
`PRAGMA foreign_key_check`, since older MES core tables have few declared FKs.
For a source disposition table that predates the three additive columns
`quality_check_id`, `reinspection_after`, and `reason`, the importer preserves
all rows and supplies only the documented defaults `NULL`, `0`, and `''`.
Other source/target column differences remain fail-closed.

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
The importer accepts the complete or projection-only schema described above,
retains scoped `MES_START` audits, and checks for enabled MES station accounts
and grants. It refuses legacy `/api/mes/report` retry state pending a reviewed
mapping. The account and grant check is structural; production enrollment and
login acceptance remain separate.

When every outbox row is processed, `--reviewed-outbox-archive ARCHIVE.sqlite`
retains the full verified source snapshot at a new path. The archive contains
all source tenants and domains. Use a private directory (0700 on Linux or
owner-only ACLs on Windows). The migration result records the archive SHA-256,
outbox content SHA-256 and counts. The archive is published without replacing
an existing file and retained if target publication later fails. Source writes
observed after snapshot creation cause refusal.

## CI fixture and limits

CI creates only disposable SQLite files. Existing cases model the complete
shared multi-station schema with finished goods. The test-first additions also
model the observed projection-only `0003` source, partial finished-goods
schemas, `MES_START` audit scope, empty station-account/grant inventory,
processed outbox archival, rejected non-processed states, and the observed
`/api/mes/report` retry-state shape. Cases use disposable data. The importer
changes await GitHub Actions results and review before merge.

Passing CI will establish only the synthetic path. It will not certify actual
source data, a complete application workflow, production downtime, deployment,
or rollback after MES has accepted new writes. The MES Go server currently has
the imported finished-goods schema, and the independent MES repository now also
contains the finished-goods HTTP handler (`backend/mes_finished_goods.go`) and
React screen (`web/src/MesFinishedGoods.tsx`), with the route wired into
`web/src/main.tsx`. The handler/UI port makes the workflow available in the MES
Go application; it does not establish that production data has been imported
or that a live cutover occurred. MES Go and Vinext SQLite remain separate
systems. D1 export/import, SQLCipher conversion, Vinext data/schema conversion,
and cross-system ERP integration migration are outside this procedure. Before
production, review exact source inventory, selected organizations, outbox
reconciliation, backups, and rollback ownership.
