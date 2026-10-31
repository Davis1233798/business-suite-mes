import test from "node:test";
import assert from "node:assert";
import { getDb } from "../../db/index.ts";
import { seedOrganization } from "../../lib/seed.ts";
import { MesService } from "../../lib/services/mes-service.ts";
import { diningTableSessions, diningTables, diningOrders, diningKitchenTickets, mesWorkOrders, mesOperations, mesMaterialLots } from "../../db/schema.ts";
import { eq, and } from "drizzle-orm";

test("P3 MES (ForgeFlow) Verification: M01 - M08", async () => {
  const orgId = `org_mes_test_${Date.now()}`;
  await seedOrganization(orgId);

  const adminCtx = {
    organizationId: orgId,
    userId: "usr_admin",
    userEmail: "admin@test.local",
    userDisplayName: "Plant Manager",
    role: "admin" as const,
    requestId: "req_mes_admin",
  };

  const operatorCtx = {
    ...adminCtx,
    userId: "usr_operator",
    role: "operator" as const,
    requestId: "req_mes_op",
  };

  const db = getDb();
  const prodId = `mes_prd_01_${orgId}`; // SKU: PRD-AL-HEAT

  // M01: BOM 循環引照檢驗 (產品不能以自己為原料)
  await assert.rejects(
    async () => {
      await MesService.createBomVersion(operatorCtx, {
        productId: prodId,
        version: 2,
        items: [{ materialSku: "PRD-AL-HEAT", materialName: "自身循環成品", quantityPerUnit: 1 }],
      });
    },
    /BOM 循環引照拒絕/
  );

  // M03: 工單開工 (未備料不得開工)
  const unstagedWoId = `wo_unstaged_${Date.now()}`;
  await db.insert(mesWorkOrders).values({
    id: unstagedWoId,
    organizationId: orgId,
    orderNo: "WO-UNSTAGED-01",
    productId: prodId,
    bomVersionId: `mes_bom_v1_${orgId}`,
    targetQuantity: 50,
    materialsStaged: false, // NOT staged!
    status: "draft",
  });

  await assert.rejects(
    async () => {
      await MesService.startWorkOrder(operatorCtx, unstagedWoId);
    },
    /備料未完成/
  );

  // Staged work order in seed (WO-202610-001)
  const stagedWoId = `mes_wo_01_${orgId}`;
  const startRes = await MesService.startWorkOrder(operatorCtx, stagedWoId);
  assert.strictEqual(startRes.status, "in_progress");

  // M04: 現場報工 (良品90、報廢10 => 完工數100；超量拒絕；負數拒絕；冪等性)
  const opId = `mes_op_01_${orgId}`;

  // Negative quantity reject
  await assert.rejects(
    async () => {
      await MesService.reportProduction(operatorCtx, {
        workOrderId: stagedWoId,
        operationId: opId,
        goodQuantity: -10,
        scrapQuantity: 0,
      });
    },
    /數量不得為負數/
  );

  // Report 90 good + 10 scrap = 100
  const repRes: any = await MesService.reportProduction(operatorCtx, {
    workOrderId: stagedWoId,
    operationId: opId,
    goodQuantity: 90,
    scrapQuantity: 10,
    idempotencyKey: "mes_rep_001",
  });
  assert.strictEqual(repRes.totalCompleted, 90);
  assert.strictEqual(repRes.totalScrapped, 10);
  assert.strictEqual(repRes.orderStatus, "completed");

  // Overfill reporting attempt -> reject (M04)
  await assert.rejects(
    async () => {
      await MesService.reportProduction(operatorCtx, {
        workOrderId: stagedWoId,
        operationId: opId,
        goodQuantity: 5,
        scrapQuantity: 0,
      });
    },
    /超量報工拒絕/
  );

  // M05: 領退料 (領200，退10 => 淨耗190；批次不足拒絕)
  const lotId = `mes_lot_01_${orgId}`; // has 300
  const matRes = await MesService.issueAndReturnMaterial(operatorCtx, {
    workOrderId: stagedWoId,
    materialLotId: lotId,
    issuedQty: 200,
    returnedQty: 10,
  });
  assert.strictEqual(matRes.issuedQuantity, 200);
  assert.strictEqual(matRes.returnedQuantity, 10);
  assert.strictEqual(matRes.netQuantity, 190);

  // Over-issue lot
  await assert.rejects(
    async () => {
      await MesService.issueAndReturnMaterial(operatorCtx, {
        workOrderId: stagedWoId,
        materialLotId: lotId,
        issuedQty: 500, // lot only has remaining 200
        returnedQty: 0,
      });
    },
    /批次庫存不足/
  );

  // M06: 品檢不合格進入隔離 (Quarantine)
  const qcRes = await MesService.recordQualityCheck(operatorCtx, {
    workOrderId: stagedWoId,
    sampleQuantity: 10,
    failedQuantity: 2, // 2 defective items
    disposition: "quarantine",
  });
  assert.strictEqual(qcRes.status, "quarantined");
  assert.strictEqual(qcRes.disposition, "quarantine");

  // M07: 停機事件不得重疊
  const wcId = `mes_wc_01_${orgId}`;
  const dt1 = await MesService.recordDowntime(operatorCtx, {
    workCenterId: wcId,
    startTime: "2026-10-30 10:00",
    reason: "刀具磨損更換",
  });
  assert.ok(dt1.downtimeId);

  // Overlapping ongoing downtime -> reject
  await assert.rejects(
    async () => {
      await MesService.recordDowntime(operatorCtx, {
        workCenterId: wcId,
        startTime: "2026-10-30 10:30",
        reason: "重複停機通報",
      });
    },
    /停機區間不得重疊/
  );

  // M08: OEE 精確計算 (排程480分、運轉360分、理論1分/件、總量300、良品270 => OEE=56.25%)
  const oee = MesService.getOeeMetrics({
    plannedMinutes: 480,
    operatingMinutes: 360,
    idealCycleMinutesPerUnit: 1,
    totalPieces: 300,
    goodPieces: 270,
  });
  assert.strictEqual(oee.availabilityPercent, 75);
  assert.strictEqual(oee.qualityPercent, 90);
  assert.strictEqual(oee.oeePercent, 56.25);
});
