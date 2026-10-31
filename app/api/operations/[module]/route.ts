import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { getDb } from "@/db";
import * as s from "@/db/schema";
import { resolveTenantContext, checkPermission, type TenantContext } from "@/lib/tenant";
import { successResponse, errorResponse } from "@/lib/api-response";
import { MesService } from "@/lib/services/mes-service";
export const dynamic = "force-dynamic";
const id = z.string().min(1).max(150), text = z.string().trim().min(1).max(250), qty = z.number().int().positive().max(1000000);
const mesSchema = z.discriminatedUnion("action", [
  z.object({action:z.literal("product"),sku:text,name:text}),
  z.object({action:z.literal("lot"),materialSku:text,lotNumber:text,quantity:qty}),
  z.object({action:z.literal("center"),code:text,name:text,capacityMinutesPerDay:qty}),
  z.object({action:z.literal("create"),productId:id,targetQuantity:qty}),
  z.object({action:z.literal("status"),workOrderId:id,status:z.enum(["released","in_progress","closed"])}),
  z.object({action:z.literal("material"),workOrderId:id,materialLotId:id,issuedQty:qty,returnedQty:z.number().int().min(0)}),
  z.object({action:z.literal("quality"),workOrderId:id,sampleQuantity:qty,failedQuantity:z.number().int().min(0),notes:text.optional()}),
  z.object({action:z.literal("downtime"),workCenterId:id,startTime:text,endTime:text,reason:text}),
  z.object({action:z.literal("bom"),productId:id,materialSku:text,materialName:text,quantityPerUnit:qty}),
]);
async function mes(context: TenantContext, input: unknown) {
  const body = mesSchema.parse(input), db = getDb(), org = context.organizationId;
  if (body.action === "product") {
    const [duplicate] = await db.select().from(s.mesProducts).where(and(eq(s.mesProducts.organizationId,org),eq(s.mesProducts.sku,body.sku)));
    if (duplicate) throw new Error("產品 SKU 已存在");
    await db.insert(s.mesProducts).values({id:crypto.randomUUID(),organizationId:org,sku:body.sku,name:body.name});
    return {message:"產品已建立，請接著建立 BOM"};
  }
  if (body.action === "lot") {
    const [duplicate] = await db.select().from(s.mesMaterialLots).where(and(eq(s.mesMaterialLots.organizationId,org),eq(s.mesMaterialLots.lotNumber,body.lotNumber)));
    if (duplicate) throw new Error("批號已存在；不可覆寫原始庫存");
    await db.insert(s.mesMaterialLots).values({id:crypto.randomUUID(),organizationId:org,materialSku:body.materialSku,lotNumber:body.lotNumber,initialQuantity:body.quantity,currentQuantity:body.quantity});
    return {message:"原料批號已入庫"};
  }
  if (body.action === "center") {
    const [duplicate] = await db.select().from(s.mesWorkCenters).where(and(eq(s.mesWorkCenters.organizationId,org),eq(s.mesWorkCenters.code,body.code)));
    if (duplicate) throw new Error("工作中心代碼已存在");
    await db.insert(s.mesWorkCenters).values({id:crypto.randomUUID(),organizationId:org,code:body.code,name:body.name,capacityMinutesPerDay:body.capacityMinutesPerDay});
    return {message:"工作中心已建立"};
  }
  if (body.action === "create") {
    const [product] = await db.select().from(s.mesProducts).where(and(eq(s.mesProducts.id,body.productId),eq(s.mesProducts.organizationId,org)));
    if (!product) throw new Error("產品不存在");
    const [bom] = await db.select().from(s.mesBomVersions).where(and(eq(s.mesBomVersions.organizationId,org),eq(s.mesBomVersions.productId,product.id),eq(s.mesBomVersions.isActive,true))).orderBy(desc(s.mesBomVersions.version));
    const [center] = await db.select().from(s.mesWorkCenters).where(eq(s.mesWorkCenters.organizationId,org));
    if (!bom || !center) throw new Error("請先建立有效 BOM 與工作中心");
    const workOrderId = crypto.randomUUID(), orderNo = `WO-${Date.now()}-${workOrderId.slice(0,4)}`;
    await db.batch([db.insert(s.mesWorkOrders).values({id:workOrderId,organizationId:org,orderNo,productId:product.id,bomVersionId:bom.id,targetQuantity:body.targetQuantity,status:"draft"}),db.insert(s.mesOperations).values({id:crypto.randomUUID(),organizationId:org,workOrderId,workCenterId:center.id,name:"標準製造",sequence:1})]);
    return { message:`已建立工單 ${orderNo}，綁定 BOM v${bom.version}` };
  }
  if (body.action === "bom") {
    const [current] = await db.select().from(s.mesBomVersions).where(and(eq(s.mesBomVersions.organizationId,org),eq(s.mesBomVersions.productId,body.productId))).orderBy(desc(s.mesBomVersions.version));
    return MesService.createBomVersion(context,{...body,version:(current?.version||0)+1,items:[{materialSku:body.materialSku,materialName:body.materialName,quantityPerUnit:body.quantityPerUnit}]});
  }
  if (body.action === "downtime") {
    const [center] = await db.select().from(s.mesWorkCenters).where(and(eq(s.mesWorkCenters.id,body.workCenterId),eq(s.mesWorkCenters.organizationId,org)));
    if (!center) throw new Error("工作中心不存在");
    const startTime = new Date(`${body.startTime}+08:00`), endTime = new Date(`${body.endTime}+08:00`);
    if (!Number.isFinite(+startTime) || !Number.isFinite(+endTime) || endTime <= startTime) throw new Error("停機結束時間必須晚於開始時間");
    return MesService.recordDowntime(context,{...body,startTime:startTime.toISOString(),endTime:endTime.toISOString()});
  }
  const [wo] = await db.select().from(s.mesWorkOrders).where(and(eq(s.mesWorkOrders.organizationId,org),eq(s.mesWorkOrders.id,body.workOrderId)));
  if (!wo) throw new Error("工單不存在");
  if (body.action === "status") {
    if (body.status === "in_progress") return MesService.startWorkOrder(context,wo.id);
    if (body.status === "released" && wo.status !== "draft") throw new Error("只有草稿可下達");
    if (body.status === "closed") {
      if (wo.status !== "completed") throw new Error("須先完成報工才能結案");
      const checks = await db.select().from(s.mesQualityChecks).where(and(eq(s.mesQualityChecks.organizationId,org),eq(s.mesQualityChecks.workOrderId,wo.id)));
      if (!checks.length || checks.some(check=>check.status !== "passed")) throw new Error("須有通過的品檢紀錄且不可仍有隔離品");
    }
    await db.update(s.mesWorkOrders).set({status:body.status}).where(and(eq(s.mesWorkOrders.id,wo.id),eq(s.mesWorkOrders.organizationId,org)));
    return {message:"工單狀態已更新"};
  }
  if (body.action === "material") {
    if (!["released","in_progress"].includes(wo.status)) throw new Error("只有已下達或生產中的工單可領料");
    return MesService.issueAndReturnMaterial(context,body);
  }
  return MesService.recordQualityCheck(context,body);
}
export async function POST(request: NextRequest, {params}: {params:Promise<{module:string}>}) {
  const context = resolveTenantContext(request);
  try {
    const {module} = await params;
    const permission = checkPermission(context,"operator");
    if (!permission.allowed) return errorResponse("FORBIDDEN",permission.message!,403,undefined,context.requestId);
    const body = await request.json();
    const result = module === "mes" ? await mes(context,body) : null;
    if (!result) return errorResponse("NOT_FOUND","找不到此模組",404,undefined,context.requestId);
    return successResponse(result,context.requestId);
  } catch(error) {
    const message = error instanceof z.ZodError ? error.issues.map(issue=>`${issue.path.join(".")}: ${issue.message}`).join("；") : error instanceof Error ? error.message : "操作失敗";
    return errorResponse("OPERATION_FAILED",message,message.includes("403") ? 403 : 400,undefined,context.requestId);
  }
}
