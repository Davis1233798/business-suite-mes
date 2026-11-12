package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type mesWorkOrderRequest struct {
	ProductID     string `json:"productId"`
	BOMID         string `json:"bomId"`
	CenterID      string `json:"centerId"`
	OrderNumber   string `json:"orderNumber"`
	Target        int64  `json:"target"`
	OperationName string `json:"operationName"`
	Minutes       int64  `json:"minutes"`
	Key           string `json:"idempotencyKey"`
}

func (a *App) mesWorkOrder(w http.ResponseWriter, r *http.Request, id *Identity, g *Grant) {
	if r.Method != http.MethodPost {
		fail(w, 405, "Use POST")
		return
	}
	if g.Role == "readonly" || g.Scope != "back" {
		fail(w, 403, "Write-enabled back-office access required")
		return
	}
	var in mesWorkOrderRequest
	if body(r, &in) != nil || len(in.Key) < 8 || len(in.Key) > 128 || in.ProductID == "" || len(in.ProductID) > 256 || in.BOMID == "" || len(in.BOMID) > 256 || in.CenterID == "" || len(in.CenterID) > 256 {
		fail(w, 400, "Select product, BOM and work center")
		return
	}
	in.OrderNumber = strings.TrimSpace(in.OrderNumber)
	in.OperationName = strings.TrimSpace(in.OperationName)
	if in.OrderNumber == "" || len(in.OrderNumber) > 100 || in.OperationName == "" || len(in.OperationName) > 200 || in.Target < 1 || in.Target > 1000000 || in.Minutes < 1 || in.Minutes > 1000000 {
		fail(w, 400, "Enter valid work order details")
		return
	}
	tx, e := a.db.BeginTx(r.Context(), nil)
	if e != nil {
		fail(w, 503, "MES unavailable")
		return
	}
	defer tx.Rollback()
	raw, _ := json.Marshal(in)
	hash := digest(id.UserID + "\x00" + string(raw))
	const endpoint = "/station/mes/work-order/create"
	var oldHash, oldBody string
	e = tx.QueryRow("SELECT request_hash,response_body FROM idempotency_keys WHERE organization_id=? AND key=? AND endpoint=?", id.OrganizationID, in.Key, endpoint).Scan(&oldHash, &oldBody)
	if e == nil {
		if hash != oldHash {
			fail(w, 409, "Retry key already used")
			return
		}
		var result map[string]any
		if json.Unmarshal([]byte(oldBody), &result) != nil {
			fail(w, 500, "Invalid retry result")
			return
		}
		ok(w, result)
		return
	}
	if !errors.Is(e, sql.ErrNoRows) {
		fail(w, 503, "Cannot read retry state")
		return
	}
	var count int
	e = tx.QueryRow("SELECT count(*) FROM mes_bom_versions b JOIN mes_products p ON p.id=b.product_id AND p.organization_id=b.organization_id WHERE b.organization_id=? AND b.id=? AND b.product_id=? AND b.is_active=1 AND p.status='active' AND EXISTS (SELECT 1 FROM mes_bom_items i WHERE i.organization_id=b.organization_id AND i.bom_version_id=b.id)", id.OrganizationID, in.BOMID, in.ProductID).Scan(&count)
	if e != nil {
		fail(w, 503, "Cannot validate BOM")
		return
	}
	if count != 1 {
		fail(w, 404, "Active product and populated BOM not found")
		return
	}
	e = tx.QueryRow("SELECT count(*) FROM mes_work_centers WHERE organization_id=? AND id=? AND status='active'", id.OrganizationID, in.CenterID).Scan(&count)
	if e != nil {
		fail(w, 503, "Cannot validate work center")
		return
	}
	if count != 1 {
		fail(w, 404, "Active work center not found")
		return
	}
	e = tx.QueryRow("SELECT count(*) FROM mes_work_orders WHERE organization_id=? AND lower(order_no)=lower(?)", id.OrganizationID, in.OrderNumber).Scan(&count)
	if e != nil {
		fail(w, 503, "Cannot validate order number")
		return
	}
	if count > 0 {
		fail(w, 409, "Work order number already exists")
		return
	}
	wo, operation := "work_order_"+token(), "operation_"+token()
	_, e = tx.Exec("INSERT INTO mes_work_orders(id,organization_id,order_no,product_id,bom_version_id,target_quantity,status,materials_staged) VALUES(?,?,?,?,?,?,'released',0)", wo, id.OrganizationID, in.OrderNumber, in.ProductID, in.BOMID, in.Target)
	if e == nil {
		_, e = tx.Exec("INSERT INTO mes_operations(id,organization_id,work_order_id,sequence,work_center_id,name,standard_minutes_per_unit,status) VALUES(?,?,?,10,?,?,?,'pending')", operation, id.OrganizationID, wo, in.CenterID, in.OperationName, in.Minutes)
	}
	result := map[string]any{"workOrderId": wo, "operationId": operation, "status": "released", "materialsStaged": false}
	encoded, _ := json.Marshal(result)
	if e == nil {
		_, e = tx.Exec("INSERT INTO idempotency_keys(id,organization_id,key,endpoint,request_hash,response_status,response_body) VALUES(?,?,?,?,?,200,?)", "idem_"+token(), id.OrganizationID, in.Key, endpoint, hash, string(encoded))
	}
	if e == nil {
		_, e = tx.Exec("INSERT INTO audit_events(id,organization_id,actor_id,actor_role,action,entity_type,entity_id,after_value) VALUES(?,?,?,?,'mes.work_order.create','mes_work_order',?,?)", "audit_"+token(), id.OrganizationID, id.UserID, g.Role, wo, string(encoded))
	}
	if e != nil {
		fail(w, 503, "Cannot save work order")
		return
	}
	if tx.Commit() != nil {
		fail(w, 503, "Cannot commit work order")
		return
	}
	ok(w, result)
}
