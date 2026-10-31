import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const stationAccounts = sqliteTable('station_accounts', {
  userId: text('user_id').primaryKey(), organizationId: text('organization_id').notNull(),
  email: text('email').notNull(), passwordHash: text('password_hash').notNull(), disabled: integer('disabled').notNull().default(0),
}, t=>[uniqueIndex('station_accounts_email').on(t.organizationId,t.email)]);
export const stationGrants = sqliteTable('station_grants', {
  userId: text('user_id').notNull(), site: text('site').notNull(), role: text('role').notNull(),
  scope: text('scope').notNull(), enabled: integer('enabled').notNull().default(1),
},t=>[uniqueIndex('station_grants_user_site').on(t.userId,t.site)]);
export const stationSessions = sqliteTable('station_sessions', {
  tokenHash:text('token_hash').primaryKey(),userId:text('user_id').notNull(),expiresAt:integer('expires_at').notNull(),
});
export const stationLoginLimits = sqliteTable('station_login_limits', {
  key:text('key').primaryKey(),attempts:integer('attempts').notNull(),resetAt:integer('reset_at').notNull(),
});

// ==========================================
// 1. Common & Tenant Tables
// ==========================================

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const memberships = sqliteTable("memberships", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("operator"), // admin, operator, readonly
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  actorId: text("actor_id").notNull(),
  actorRole: text("actor_role").notNull(),
  action: text("action").notNull(), // UPDATE_AMOUNT, UPDATE_ROLE, DEDUCT_STOCK, REFUND, etc.
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  beforeValue: text("before_value"),
  afterValue: text("after_value"),
  reason: text("reason"),
  requestId: text("request_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  key: text("key").notNull(),
  endpoint: text("endpoint").notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status").notNull(),
  responseBody: text("response_body").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const outboxEvents = sqliteTable("outbox_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull().default("pending"), // pending, processed, failed
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ==========================================
// 2. MES「ForgeFlow」Tables
// ==========================================

export const mesProducts = sqliteTable("mes_products", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  unit: text("unit").notNull().default("PCS"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const mesBomVersions = sqliteTable("mes_bom_versions", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  productId: text("product_id").notNull(),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("active"), // draft, active, archived
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const mesBomItems = sqliteTable("mes_bom_items", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  bomVersionId: text("bom_version_id").notNull(),
  materialSku: text("material_sku").notNull(),
  materialName: text("material_name").notNull(),
  quantityPerUnit: integer("quantity_per_unit").notNull(),
  unit: text("unit").notNull().default("PCS"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const mesWorkCenters = sqliteTable("mes_work_centers", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  capacityMinutesPerDay: integer("capacity_minutes_per_day").notNull().default(480),
  status: text("status").notNull().default("active"), // active, maintenance
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const mesWorkOrders = sqliteTable("mes_work_orders", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  orderNo: text("order_no").notNull(),
  productId: text("product_id").notNull(),
  bomVersionId: text("bom_version_id").notNull(),
  targetQuantity: integer("target_quantity").notNull(),
  completedQuantity: integer("completed_quantity").notNull().default(0),
  scrappedQuantity: integer("scrapped_quantity").notNull().default(0),
  status: text("status").notNull().default("draft"), // draft, released, in_progress, completed, closed
  materialsStaged: integer("materials_staged", { mode: "boolean" }).notNull().default(false),
  scheduledMinutes: integer("scheduled_minutes").notNull().default(480),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const mesOperations = sqliteTable("mes_operations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  workOrderId: text("work_order_id").notNull(),
  sequence: integer("sequence").notNull(),
  workCenterId: text("work_center_id").notNull(),
  name: text("name").notNull(),
  standardMinutesPerUnit: integer("standard_minutes_per_unit").notNull().default(1),
  status: text("status").notNull().default("pending"), // pending, running, completed
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const mesMaterialLots = sqliteTable("mes_material_lots", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  lotNumber: text("lot_number").notNull(),
  materialSku: text("material_sku").notNull(),
  initialQuantity: integer("initial_quantity").notNull(),
  currentQuantity: integer("current_quantity").notNull(),
  status: text("status").notNull().default("available"), // available, quarantined, consumed
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const mesWorkOrderMaterials = sqliteTable("mes_work_order_materials", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  workOrderId: text("work_order_id").notNull(),
  materialLotId: text("material_lot_id").notNull(),
  materialSku: text("material_sku").notNull(),
  issuedQuantity: integer("issued_quantity").notNull(),
  returnedQuantity: integer("returned_quantity").notNull().default(0),
  netQuantity: integer("net_quantity").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const mesProductionReports = sqliteTable("mes_production_reports", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  workOrderId: text("work_order_id").notNull(),
  operationId: text("operation_id").notNull(),
  operatorId: text("operator_id").notNull(),
  goodQuantity: integer("good_quantity").notNull(),
  scrapQuantity: integer("scrap_quantity").notNull(),
  reportTime: text("report_time").notNull().default(sql`CURRENT_TIMESTAMP`),
  notes: text("notes"),
  idempotencyKey: text("idempotency_key"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const mesQualityChecks = sqliteTable("mes_quality_checks", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  workOrderId: text("work_order_id").notNull(),
  reportId: text("report_id"),
  inspectorId: text("inspector_id").notNull(),
  sampleQuantity: integer("sample_quantity").notNull(),
  passedQuantity: integer("passed_quantity").notNull(),
  failedQuantity: integer("failed_quantity").notNull(),
  status: text("status").notNull().default("passed"), // passed, quarantined, reworked
  disposition: text("disposition"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const mesDowntimeEvents = sqliteTable("mes_downtime_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  workCenterId: text("work_center_id").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time"),
  durationMinutes: integer("duration_minutes").default(0),
  reason: text("reason").notNull(),
  reporterId: text("reporter_id").notNull(),
  status: text("status").notNull().default("ongoing"), // ongoing, resolved
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ==========================================
// 3. ERP「LedgerWorks」Tables
// ==========================================

export const erpStockLedger = sqliteTable("erp_stock_ledger", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  itemId: text("item_id").notNull(),
  warehouseId: text("warehouse_id").notNull(),
  changeType: text("change_type").notNull(), // purchase_receipt, purchase_return, sales_shipment, transfer_in, transfer_out, adjustment
  quantityChange: integer("quantity_change").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  unitCost: integer("unit_cost").notNull().default(0),
  totalValue: integer("total_value").notNull().default(0),
  referenceDoc: text("reference_doc").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const posSales = sqliteTable("pos_sales", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  receiptNumber: text("receipt_number").notNull(),
  storeId: text("store_id").notNull(),
  registerId: text("register_id").notNull(),
  shiftId: text("shift_id").notNull(),
  cashierId: text("cashier_id").notNull(),
  customerId: text("customer_id"),
  subtotal: integer("subtotal").notNull(),
  discountAmount: integer("discount_amount").notNull().default(0),
  taxAmount: integer("tax_amount").notNull().default(0),
  totalAmount: integer("total_amount").notNull(),
  tenderAmount: integer("tender_amount").notNull(),
  changeAmount: integer("change_amount").notNull().default(0),
  paymentMethod: text("payment_method").notNull().default("cash"),
  status: text("status").notNull().default("completed"), // completed, refunded, partially_refunded
  isReprint: integer("is_reprint", { mode: "boolean" }).notNull().default(false),
  idempotencyKey: text("idempotency_key"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const diningTables = sqliteTable("dining_tables", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  locationId: text("location_id").notNull(),
  tableNumber: text("table_number").notNull(),
  capacity: integer("capacity").notNull(),
  status: text("status").notNull().default("vacant"), // vacant, occupied, reserved, cleaning
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const diningTableSessions = sqliteTable("dining_table_sessions", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  tableId: text("table_id").notNull(),
  sessionToken: text("session_token").notNull().unique(),
  guestCount: integer("guest_count").notNull().default(2),
  status: text("status").notNull().default("active"), // active, billed, closed
  openedAt: text("opened_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  closedAt: text("closed_at"),
});

export const diningOrders = sqliteTable("dining_orders", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  sessionId: text("session_id"),
  orderType: text("order_type").notNull().default("dine_in"), // dine_in, takeout
  takeoutNumber: text("takeout_number"),
  subtotal: integer("subtotal").notNull(),
  serviceCharge: integer("service_charge").notNull().default(0),
  totalAmount: integer("total_amount").notNull(),
  status: text("status").notNull().default("placed"), // placed, preparing, served, completed, cancelled
  idempotencyKey: text("idempotency_key"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [uniqueIndex("dining_orders_takeout_number_unique").on(table.organizationId, table.takeoutNumber)]);

export const diningKitchenTickets = sqliteTable("dining_kitchen_tickets", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  orderId: text("order_id").notNull(),
  orderItemId: text("order_item_id").notNull(),
  station: text("station").notNull(),
  itemName: text("item_name").notNull(),
  quantity: integer("quantity").notNull(),
  modifiersText: text("modifiers_text"),
  status: text("status").notNull().default("received"), // received, cooking, done, served
  urgentFlag: integer("urgent_flag", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const shopOrders = sqliteTable("shop_orders", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  orderNumber: text("order_number").notNull(),
  userId: text("user_id"),
  customerEmail: text("customer_email").notNull(),
  shippingAddressJson: text("shipping_address_json").notNull(),
  subtotal: integer("subtotal").notNull(),
  discountAmount: integer("discount_amount").notNull().default(0),
  shippingFee: integer("shipping_fee").notNull().default(0),
  totalAmount: integer("total_amount").notNull(),
  paymentStatus: text("payment_status").notNull().default("pending"), // pending, paid, failed, refunded
  fulfillmentStatus: text("fulfillment_status").notNull().default("unfulfilled"), // unfulfilled, partially_shipped, shipped, delivered
  trackingNumber: text("tracking_number"),
  idempotencyKey: text("idempotency_key"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const demoSeedStates = sqliteTable("demo_seed_states", { organizationId: text("organization_id").primaryKey(), readyAt: text("ready_at").notNull().default(sql`CURRENT_TIMESTAMP`) });
