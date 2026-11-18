# MES Multi-Operation Sequence Workflow, Operation State Machine & OEE

## 1. Architectural Context & Scope
In accordance with `DEVELOP_PLAN.md` (MES P1: Completion of Core Manufacturing Flow and OEE) and `HARNESS.md`, this document specifies:
1. **Multi-Operation Work Order Sequence**: Permitting back-office planners to configure multiple routing operations (e.g., Sequence 10: Machining, 20: Assembly, 30: Testing, 40: Packaging) on active or released work orders.
2. **Operation State Machine & Sequential Inter-Operation Invariants**:
   - Each operation maintains its lifecycle state (`pending` -> `in_progress` -> `completed`).
   - For an operation with sequence $S_k$, its cumulative input (good reported + scrap reported) cannot exceed the cumulative good output of the immediate preceding operation $S_{k-1}$ ($S_{k-1} \rightarrow S_k$ progress conservation).
   - If $S_k$ is the initial operation ($k=1$), its cumulative reported quantity cannot exceed the work order's `target_quantity`.
   - Finished goods completion (`mes_work_orders.completed_quantity`) is updated by the terminal (highest sequence) operation, preserving accurate finished goods release to downstream QA and warehouse receipts.
3. **Overall Equipment Effectiveness (OEE)**:
   - Implements standardized OEE computation:
     - $\text{Availability} = \frac{\text{Operating Minutes}}{\text{Planned Production Minutes}}$
     - $\text{Performance} = \frac{\text{Ideal Cycle Minutes Per Unit} \times \text{Total Pieces}}{\text{Operating Minutes}}$
     - $\text{Quality} = \frac{\text{Good Pieces}}{\text{Total Pieces}}$
     - $\text{OEE} = \text{Availability} \times \text{Performance} \times \text{Quality}$
   - Conforms strictly to M08 fixture: Planned 480m, Operating 360m, Ideal 1m/unit, Total 300 units, Good 270 units $\rightarrow$ Availability = 75%, Performance = 83.333...%, Quality = 90%, OEE = 56.25%.
   - Robust division-by-zero handling: when any denominator is zero or negative, returns `hasData: false, oeePercent: null` rather than crashing or synthesizing false data.

## 2. API Contracts & Boundary Guarantees
### `POST /api/stations/mes/work-orders` (Action: `addOperation`)
- **Authorization**: Back-office scope, non-readonly role (`g.Scope == "back" && g.Role != "readonly"`).
- **Payload**:
  ```json
  {
    "action": "addOperation",
    "workOrderId": "work_order_...",
    "centerId": "center_...",
    "sequence": 20,
    "operationName": "Final Assembly",
    "minutes": 5,
    "idempotencyKey": "idem_..."
  }
  ```
- **Validation**:
  - `workOrderId` must belong to current tenant; status cannot be `closed`.
  - `centerId` must belong to current tenant and be `active`.
  - `sequence` must be unique for this work order and $> 0$.
  - `operationName` trimmed 1-200 characters.
  - `minutes` between 1 and 1,000,000.
- **Idempotency & Auditing**:
  - Validates request digest against `idempotency_keys`. Replays on identical hash, 409 Conflict on payload mismatch.
  - Emits audit event `mes.operation.create`.

### `POST /api/stations/mes/business` (Action: `report`)
- **Sequential Invariants**:
  - Identifies operation sequence for `operationId`.
  - Determines preceding operation $S_{k-1}$ if $k > 1$.
  - Asserts cumulative reported units on $S_k \le \text{Good produced by } S_{k-1}$.
  - Transitions operation status to `in_progress`, and `completed` when all available preceding good units have been processed.
  - Terminal operation updates `mes_work_orders.completed_quantity`. Any scrap at intermediate stages updates `mes_work_orders.scrapped_quantity`.

### `GET /api/stations/mes/oee`
- **Query Parameters**: `plannedMinutes`, `operatingMinutes`, `idealCycleMinutes`, `totalPieces`, `goodPieces`.
- **Response**:
  ```json
  {
    "hasData": true,
    "availabilityPercent": 75.0,
    "performancePercent": 83.3333,
    "qualityPercent": 90.0,
    "oeePercent": 56.25
  }
  ```
