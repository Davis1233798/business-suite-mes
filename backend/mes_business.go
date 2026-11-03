package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type mesCommand struct {
	Action         string `json:"action"`
	WorkOrderID    string `json:"workOrderId"`
	OperationID    string `json:"operationId"`
	Good           int    `json:"goodQuantity"`
	Scrap          int    `json:"scrapQuantity"`
	Notes          string `json:"notes"`
	IdempotencyKey string `json:"idempotencyKey"`
}

func (a *App) mesBusiness(w http.ResponseWriter, r *http.Request, id *Identity, grant *Grant) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "Use POST")
		return
	}
	if grant.Role != "admin" && grant.Role != "operator" {
		fail(w, http.StatusForbidden, "A write-enabled role is required")
		return
	}
	var in mesCommand
	if body(r, &in) != nil || len(in.WorkOrderID) == 0 || len(in.WorkOrderID) > 256 || len(in.Notes) > 500 {
		fail(w, http.StatusBadRequest, "Invalid production request")
		return
	}
	if in.Action != "start" && in.Action != "report" {
		fail(w, http.StatusBadRequest, "Unknown production action")
		return
	}
	if in.Action == "start" && grant.Scope != "back" {
		fail(w, http.StatusForbidden, "Starting an order requires back-office access")
		return
	}
	if in.Action == "report" && (len(in.OperationID) == 0 || len(in.OperationID) > 256 || len(in.IdempotencyKey) < 8 || len(in.IdempotencyKey) > 128 || in.Good < 0 || in.Scrap < 0 || in.Good > 1000000 || in.Scrap > 1000000 || in.Good+in.Scrap == 0) {
		fail(w, http.StatusBadRequest, "Invalid report quantities, operation, or retry key")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "Production service unavailable")
		return
	}
	defer tx.Rollback()
	const endpoint = "/station/mes/report"
	raw, _ := json.Marshal(in)
	fingerprint := digest(id.UserID + "\x00" + string(raw))
	if in.Action == "report" {
		var previousHash, previousBody string
		err = tx.QueryRowContext(r.Context(), "SELECT request_hash,response_body FROM idempotency_keys WHERE organization_id=? AND key=? AND endpoint=?", id.OrganizationID, in.IdempotencyKey, endpoint).Scan(&previousHash, &previousBody)
		if err == nil {
			if previousHash != fingerprint {
				fail(w, http.StatusConflict, "Retry key was used for a different request")
				return
			}
			var value any
			if json.Unmarshal([]byte(previousBody), &value) != nil {
				fail(w, http.StatusInternalServerError, "Invalid stored result")
				return
			}
			ok(w, value)
			return
		}
		if !errors.Is(err, sql.ErrNoRows) {
			fail(w, http.StatusServiceUnavailable, "Cannot read retry state")
			return
		}
	}
	var status string
	var staged, target, good, scrap int
	err = tx.QueryRowContext(r.Context(), "SELECT status,materials_staged,target_quantity,completed_quantity,scrapped_quantity FROM mes_work_orders WHERE organization_id=? AND id=?", id.OrganizationID, in.WorkOrderID).Scan(&status, &staged, &target, &good, &scrap)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, http.StatusNotFound, "Work order not found")
		return
	}
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "Cannot read work order")
		return
	}
	result := map[string]any{"workOrderId": in.WorkOrderID}
	auditAction := "mes.start"
	if in.Action == "start" {
		if status != "released" || staged != 1 {
			fail(w, http.StatusConflict, "Work order must be released and materials staged")
			return
		}
		var totalBOM, missing int
		err = tx.QueryRowContext(r.Context(), `SELECT COUNT(*),COALESCE(SUM(CASE WHEN b.quantity_per_unit<=0 OR b.quantity_per_unit*? > COALESCE((SELECT SUM(m.net_quantity) FROM mes_work_order_materials m WHERE m.organization_id=b.organization_id AND m.work_order_id=? AND m.material_sku=b.material_sku),0) THEN 1 ELSE 0 END),0) FROM mes_bom_items b JOIN mes_work_orders w ON w.bom_version_id=b.bom_version_id AND w.organization_id=b.organization_id WHERE w.organization_id=? AND w.id=?`, target, in.WorkOrderID, id.OrganizationID, in.WorkOrderID).Scan(&totalBOM, &missing)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "Cannot verify staged materials")
			return
		}
		if target < 1 || totalBOM == 0 || missing != 0 {
			fail(w, http.StatusConflict, "BOM materials are not fully staged")
			return
		}
		res, e := tx.ExecContext(r.Context(), "UPDATE mes_work_orders SET status='in_progress' WHERE organization_id=? AND id=? AND status='released' AND materials_staged=1", id.OrganizationID, in.WorkOrderID)
		if e != nil {
			fail(w, http.StatusServiceUnavailable, "Unable to start work order")
			return
		}
		n, e := res.RowsAffected()
		if e != nil || n != 1 {
			fail(w, http.StatusConflict, "Work order changed; refresh and retry")
			return
		}
		result["status"] = "in_progress"
	} else {
		var operations int
		err = tx.QueryRowContext(r.Context(), "SELECT count(*) FROM mes_operations WHERE organization_id=? AND work_order_id=? AND id=?", id.OrganizationID, in.WorkOrderID, in.OperationID).Scan(&operations)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "Cannot validate operation")
			return
		}
		if operations != 1 {
			fail(w, http.StatusNotFound, "Operation not found for this work order")
			return
		}
		if status != "in_progress" || good+scrap+in.Good+in.Scrap > target {
			fail(w, http.StatusConflict, "Work order is not in progress or report exceeds its target")
			return
		}
		nextStatus := "in_progress"
		if good+scrap+in.Good+in.Scrap == target {
			nextStatus = "completed"
		}
		res, e := tx.ExecContext(r.Context(), "UPDATE mes_work_orders SET completed_quantity=completed_quantity+?,scrapped_quantity=scrapped_quantity+?,status=? WHERE organization_id=? AND id=? AND status='in_progress' AND completed_quantity+scrapped_quantity+?<=target_quantity", in.Good, in.Scrap, nextStatus, id.OrganizationID, in.WorkOrderID, in.Good+in.Scrap)
		if e != nil {
			fail(w, http.StatusServiceUnavailable, "Unable to commit production report")
			return
		}
		n, e := res.RowsAffected()
		if e != nil || n != 1 {
			fail(w, http.StatusConflict, "Work order changed; refresh and retry")
			return
		}
		reportID := "report_" + token()
		_, err = tx.ExecContext(r.Context(), "INSERT INTO mes_production_reports(id,organization_id,work_order_id,operation_id,operator_id,good_quantity,scrap_quantity,notes,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?)", reportID, id.OrganizationID, in.WorkOrderID, in.OperationID, id.UserID, in.Good, in.Scrap, strings.TrimSpace(in.Notes), in.IdempotencyKey)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "Unable to save production report")
			return
		}
		result["reportId"], result["goodQuantity"], result["scrapQuantity"], result["totalCompleted"], result["totalScrapped"], result["status"] = reportID, in.Good, in.Scrap, good+in.Good, scrap+in.Scrap, nextStatus
		encoded, _ := json.Marshal(result)
		_, err = tx.ExecContext(r.Context(), "INSERT INTO idempotency_keys(id,organization_id,key,endpoint,request_hash,response_status,response_body) VALUES(?,?,?,?,?,200,?)", "idem_"+token(), id.OrganizationID, in.IdempotencyKey, endpoint, fingerprint, string(encoded))
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "Unable to save retry state")
			return
		}
		auditAction = "mes.report"
	}
	after, _ := json.Marshal(result)
	_, err = tx.ExecContext(r.Context(), "INSERT INTO audit_events(id,organization_id,actor_id,actor_role,action,entity_type,entity_id,before_value,after_value) VALUES(?,?,?,?,?,'mes_work_order',?,?,?)", "audit_"+token(), id.OrganizationID, id.UserID, grant.Role, auditAction, in.WorkOrderID, fmt.Sprintf("{\"status\":%q}", status), string(after))
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "Unable to record production audit")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, http.StatusServiceUnavailable, "Production transaction failed")
		return
	}
	ok(w, result)
}
