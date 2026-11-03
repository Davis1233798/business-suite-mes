# MES finished goods workflow

## Base and source

Implementation base: `business-suite-mes` `c6cad02f00b715b5f92587456c49626b7735cf3f`.
Reference workflow: `profolio` `48039da886a2f5317430cb01d831f1f847af8435`.
This port uses MES-owned SQLite tables, the MES Go API, and the existing React/Vite bundle. It does not connect to a shared Portfolio database.

## Data and ownership boundary

The additive `0006_mes_finished_goods.sql` migration creates `mes_finished_goods_batches`, `mes_finished_goods_quality_dispositions`, `mes_finished_goods_inventory`, and `mes_finished_goods_receipts`. `0007_mes_finished_goods_resolutions.sql` adds the immutable rework/scrap resolution ledger. Rows are scoped by `organization_id`, tied to MES work orders, reports, and inspection checks, and protected by constraints/triggers. Existing completed orders are not implicitly released, receipted, or closed.

Only the MES finished-goods handler may change these tables. Each command is one SQLite transaction containing business rows, an idempotency response, an audit event, and (for MES receipt) an outbox event. A receipt increases MES finished-goods inventory. It does not write ERP stock, map ERP item/warehouse ids, or assume a shared database. The outbox event is an integration notice only; no ERP consumer or delivery is part of this feature.

## API contract

`POST /api/stations/mes/finished-goods` requires an authenticated MES `admin` grant with `back` scope. The handler is organization-scoped and supports `createBatch`, `qualityDisposition`, `resolveQuarantine`, `receive`, and `close`. Every action requires an 8–128 character idempotency key; same key/action/payload replays the stored response, while a changed payload returns 409.

Batch creation must bind a completed MES work order and its production report; aggregate batches cannot exceed the report's good quantity. Inspection disposition must reference matching MES quality evidence and account for the batch quantity. Quarantine blocks receipt until a reasoned rework or scrap resolution. Rework requires a later inspection. Receipt is allowed only for a fully released batch and creates MES receipt/inventory plus `mes.finished_goods.received` outbox event. Work-order close requires all target quantity accounted for as received good quantity or scrapped output, with no unresolved batches.

Read data extends `GET /api/stations/mes/data` with batches, quality dispositions, inventory, receipts, and resolutions. The UI displays these datasets and actions; only administrators get enabled mutation controls. The existing MES production endpoint supplies report records; the port adds `/api/stations/mes/operations` for MES quality-check evidence used by batch disposition.

## Acceptance tests (write before implementation)

- Migration tests: new schema on a clean MES DB; upgrade from the current schema; existing completed reports remain untouched and no batch/inventory is synthesized; constraints reject cross-organization references, over-allocation, invalid dispositions, and invalid resolution quantities.
- Handler tests: admin/back success; operator, readonly, and front-scope denial; unknown tenant references return not found; batch trace and quantity cap; only matching inspection evidence permits release/quarantine; stale pre-rework check cannot release; quarantine needs a reasoned rework/scrap decision; receiving twice with different keys cannot double-post; same-key replay returns stored response and changed payload returns 409; failed audit/outbox write rolls back all business and idempotency rows.
- Closure tests: open batch blocks close; all good quantity must be received; all-scrap completed order can close without inventory; legacy completed order cannot close until explicitly reconciled.
- Isolation tests: receipt writes MES inventory and one MES outbox event only; ERP tables and ERP mapping tables are unchanged; selected tenant cannot see or mutate another tenant's batches.
- UI tests: derived status/inspection choices/resolution history; empty and populated states; action gating for admin role and batch state; request errors preserve retry key; save refreshes data; no ERP destination controls or copy imply a cross-station write.

## Cutover / operational limits

Use the MES-owned DB configured by the MES service. Do not run these migrations against the Portfolio Go database. Deploy schema before enabling the screen. Reconcile outstanding quarantines and receipts before closing historical work orders. API and UI tests run in GitHub CI with isolated synthetic DBs only; no production DB or credentials are part of this workflow.
