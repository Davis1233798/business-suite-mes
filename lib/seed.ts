import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  organizations,
  demoSeedStates,
  users,
  memberships,
  mesProducts,
  mesBomVersions,
  mesBomItems,
  mesWorkCenters,
  mesWorkOrders,
  mesOperations,
  mesMaterialLots,
  mesWorkOrderMaterials,
} from "../db/schema";

// Fictional fixtures only: no real brands, personal phone numbers or delivery addresses.
export async function seedOrganization(orgId: string = "org_demo_default") {
  const db = getDb();

  // 1. Organization & Core Users
  const existingOrg = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (existingOrg.length === 0) {
    await db.insert(organizations).values({
      id: orgId,
      name: "示範企業 (Business Suite Enterprise)",
      slug: orgId,
    }).onConflictDoNothing();
  }

  // Users
  const adminUser = { id: `usr_${orgId}_admin`, email: "admin@suite.test", displayName: "示範管理員 (Admin)" };
  const operatorUser = { id: `usr_${orgId}_op`, email: "operator@suite.test", displayName: "示範作業員 / 現場主管" };
  const readonlyUser = { id: `usr_${orgId}_ro`, email: "guest@suite.test", displayName: "訪客 (唯讀)" };

  for (const u of [adminUser, operatorUser, readonlyUser]) {
    const exists = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
    if (exists.length === 0) {
      await db.insert(users).values(u).onConflictDoNothing();
    }
  }

  // Memberships
  const memberRoles = [
    { userId: adminUser.id, role: "admin" },
    { userId: operatorUser.id, role: "operator" },
    { userId: readonlyUser.id, role: "readonly" },
  ];
  for (const m of memberRoles) {
    const memId = `mem_${orgId}_${m.userId}`;
    const exists = await db.select().from(memberships).where(eq(memberships.id, memId)).limit(1);
    if (exists.length === 0) {
      await db.insert(memberships).values({
        id: memId,
        organizationId: orgId,
        userId: m.userId,
        role: m.role,
      }).onConflictDoNothing();
    }
  }

  // ==========================================
  // 2. MES「ForgeFlow」Seed
  // ==========================================
  const prd1 = {
    id: `mes_prd_01_${orgId}`,
    organizationId: orgId,
    sku: "PRD-AL-HEAT",
    name: "鋁合金散熱模組 (Alloy Heat Module A)",
    unit: "PCS",
    status: "active",
  };
  await db.insert(mesProducts).values(prd1).onConflictDoNothing();

  const bom1 = {
    id: `mes_bom_v1_${orgId}`,
    organizationId: orgId,
    productId: prd1.id,
    version: 1,
    status: "active",
    isActive: true,
    notes: "標準生產BOM v1 (每件耗原鋁2件、散熱膏1管)",
  };
  await db.insert(mesBomVersions).values(bom1).onConflictDoNothing();

  await db.insert(mesBomItems).values([
    {
      id: `mes_item_01_${orgId}`,
      organizationId: orgId,
      bomVersionId: bom1.id,
      materialSku: "RAW-ALUM-6061",
      materialName: "航太級6061原鋁塊",
      quantityPerUnit: 2, // 2 pieces per PRD-A
      unit: "PCS",
    },
    {
      id: `mes_item_02_${orgId}`,
      organizationId: orgId,
      bomVersionId: bom1.id,
      materialSku: "RAW-THERMAL-PASTE",
      materialName: "高效能導熱膏",
      quantityPerUnit: 1,
      unit: "TUBE",
    },
  ]).onConflictDoNothing();

  const wc1 = {
    id: `mes_wc_01_${orgId}`,
    organizationId: orgId,
    code: "WC-CNC-01",
    name: "精密五軸CNC切削中心",
    capacityMinutesPerDay: 480, // 8 hours
    status: "active",
  };
  const wc2 = {
    id: `mes_wc_02_${orgId}`,
    organizationId: orgId,
    code: "WC-ANODIZE-01",
    name: "陽極氧化表面處理線",
    capacityMinutesPerDay: 480,
    status: "active",
  };
  await db.insert(mesWorkCenters).values([wc1, wc2]).onConflictDoNothing();

  // Material lots
  const lot1 = {
    id: `mes_lot_01_${orgId}`,
    organizationId: orgId,
    lotNumber: "LOT-202610-AL01",
    materialSku: "RAW-ALUM-6061",
    initialQuantity: 500,
    currentQuantity: 300,
    status: "available",
  };
  await db.insert(mesMaterialLots).values(lot1).onConflictDoNothing();

  // Work Order 100
  const wo1 = {
    id: `mes_wo_01_${orgId}`,
    organizationId: orgId,
    orderNo: "WO-202610-001",
    productId: prd1.id,
    bomVersionId: bom1.id,
    targetQuantity: 100,
    completedQuantity: 0,
    scrappedQuantity: 0,
    status: "released",
    materialsStaged: true,
    scheduledMinutes: 480,
  };
  await db.insert(mesWorkOrders).values(wo1).onConflictDoNothing();

  await db.insert(mesOperations).values([
    {
      id: `mes_op_01_${orgId}`,
      organizationId: orgId,
      workOrderId: wo1.id,
      sequence: 10,
      workCenterId: wc1.id,
      name: "精密CNC切削成型",
      standardMinutesPerUnit: 1,
      status: "pending",
    },
    {
      id: `mes_op_02_${orgId}`,
      organizationId: orgId,
      workOrderId: wo1.id,
      sequence: 20,
      workCenterId: wc2.id,
      name: "陽極硬化處理",
      standardMinutesPerUnit: 1,
      status: "pending",
    },
  ]).onConflictDoNothing();

  await db.insert(mesWorkOrderMaterials).values({
    id: `mes_wom_01_${orgId}`,
    organizationId: orgId,
    workOrderId: wo1.id,
    materialLotId: lot1.id,
    materialSku: "RAW-ALUM-6061",
    issuedQuantity: 200,
    returnedQuantity: 10,
    netQuantity: 190,
  }).onConflictDoNothing();

  await db.insert(demoSeedStates).values({ organizationId: orgId }).onConflictDoNothing();
  return { success: true, organizationId: orgId };
}
