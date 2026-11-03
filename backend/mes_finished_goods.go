package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

type mesFinishedGoodsRequest struct {
	Action         string `json:"action"`
	WorkOrderID    string `json:"workOrderId"`
	ReportID       string `json:"reportId"`
	BatchID        string `json:"batchId"`
	QualityCheckID string `json:"qualityCheckId"`
	BatchNumber    string `json:"batchNumber"`
	Quantity       int64  `json:"quantity"`
	Passed         int64  `json:"passedQuantity"`
	Failed         int64  `json:"failedQuantity"`
	Disposition    string `json:"disposition"`
	Reason         string `json:"reason"`
	Key            string `json:"idempotencyKey"`
}

func (a *App) mesFinishedGoods(w http.ResponseWriter, r *http.Request, id *Identity, g *Grant) {
	if r.Method != http.MethodPost {
		fail(w, 405, "Use POST")
		return
	}
	if g.Role != "admin" || g.Scope != "back" {
		fail(w, 403, "Back-office administrator required")
		return
	}
	var in mesFinishedGoodsRequest
	if body(r, &in) != nil || len(in.Key) < 8 || len(in.Key) > 128 || len(in.WorkOrderID) > 256 || len(in.ReportID) > 256 || len(in.BatchID) > 256 || len(in.QualityCheckID) > 256 || len(in.BatchNumber) > 128 {
		fail(w, 400, "Invalid finished goods request")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 503, "MES unavailable")
		return
	}
	defer tx.Rollback()
	raw, _ := json.Marshal(in)
	hash := digest(id.UserID + "\x00" + string(raw))
	endpoint := "/station/mes/finished-goods/" + in.Action
	var oldHash, oldBody string
	err = tx.QueryRow("SELECT request_hash,response_body FROM idempotency_keys WHERE organization_id=? AND key=? AND endpoint=?", id.OrganizationID, in.Key, endpoint).Scan(&oldHash, &oldBody)
	if err == nil {
		if oldHash != hash {
			fail(w, 409, "Retry key already used")
			return
		}
		var v map[string]any
		if json.Unmarshal([]byte(oldBody), &v) != nil {
			fail(w, 500, "Invalid stored result")
			return
		}
		ok(w, v)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		fail(w, 503, "Cannot inspect retry state")
		return
	}
	result := map[string]any{}
	entity := ""
	switch in.Action {
	case "createBatch":
		in.BatchNumber = strings.TrimSpace(in.BatchNumber)
		if in.WorkOrderID == "" || in.ReportID == "" || in.BatchNumber == "" || in.Quantity < 1 || in.Quantity > 1000000 {
			fail(w, 400, "Invalid batch")
			return
		}
		var status string
		var good, used int64
		err = tx.QueryRow("SELECT w.status,r.good_quantity FROM mes_work_orders w JOIN mes_production_reports r ON r.organization_id=w.organization_id AND r.work_order_id=w.id WHERE w.organization_id=? AND w.id=? AND r.id=?", id.OrganizationID, in.WorkOrderID, in.ReportID).Scan(&status, &good)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 404, "Report not found")
			return
		}
		if err != nil {
			fail(w, 503, "Cannot read report")
			return
		}
		if err = tx.QueryRow("SELECT COALESCE(SUM(quantity),0) FROM mes_finished_goods_batches WHERE organization_id=? AND report_id=?", id.OrganizationID, in.ReportID).Scan(&used); err != nil {
			fail(w, 503, "Cannot read batches")
			return
		}
		if status != "completed" || in.Quantity > good-used {
			fail(w, 409, "Batch exceeds completed report")
			return
		}
		entity = "fg_" + token()
		_, err = tx.Exec("INSERT INTO mes_finished_goods_batches(id,organization_id,work_order_id,report_id,batch_number,quantity,status) VALUES(?,?,?,?,?,?,'pending_inspection')", entity, id.OrganizationID, in.WorkOrderID, in.ReportID, in.BatchNumber, in.Quantity)
		if err != nil {
			fail(w, 409, "Cannot create batch")
			return
		}
		result["batchId"], result["status"] = entity, "pending_inspection"
	case "qualityDisposition", "receive", "resolveQuarantine":
		if in.BatchID == "" {
			fail(w, 400, "Select a batch")
			return
		}
		var state, orderStatus, productID string
		var quantity int64
		err = tx.QueryRow("SELECT b.status,b.quantity,w.status,w.product_id FROM mes_finished_goods_batches b JOIN mes_work_orders w ON w.organization_id=b.organization_id AND w.id=b.work_order_id WHERE b.organization_id=? AND b.id=?", id.OrganizationID, in.BatchID).Scan(&state, &quantity, &orderStatus, &productID)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 404, "Batch not found")
			return
		}
		if err != nil {
			fail(w, 503, "Cannot read batch")
			return
		}
		entity = in.BatchID
		if in.Action == "resolveQuarantine" {
			in.Reason = strings.TrimSpace(in.Reason)
			if in.Reason == "" || len(in.Reason) > 500 || (in.Disposition != "rework" && in.Disposition != "scrap") {
				fail(w, 400, "A resolution and reason are required")
				return
			}
			if state != "quarantined" || orderStatus != "completed" {
				fail(w, 409, "Batch is not awaiting quarantine resolution")
				return
			}
			next := "pending_inspection"
			if in.Disposition == "scrap" {
				next = "scrapped"
			}
			_, err = tx.Exec("INSERT INTO mes_finished_goods_resolutions(id,organization_id,batch_id,quantity,disposition,reason,reinspection_after) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(rowid),0) FROM mes_quality_checks))", "fgrs_"+token(), id.OrganizationID, entity, quantity, in.Disposition, in.Reason)
			if err == nil {
				_, err = tx.Exec("UPDATE mes_finished_goods_batches SET status=? WHERE organization_id=? AND id=?", next, id.OrganizationID, entity)
			}
			result["status"] = next
		} else if in.Action == "qualityDisposition" {
			if in.QualityCheckID == "" {
				fail(w, 400, "Select inspection evidence")
				return
			}
			if in.Passed < 0 || in.Passed > 1000000 || in.Failed < 0 || in.Failed > 1000000 || in.Passed+in.Failed != quantity || (in.Disposition != "release" && in.Disposition != "quarantine") || (in.Disposition == "release" && in.Failed != 0) {
				fail(w, 400, "Invalid quality disposition")
				return
			}
			if state != "pending_inspection" || orderStatus != "completed" {
				fail(w, 409, "Batch cannot be inspected")
				return
			}
			var failed, passed, sample, inspectionRow, reinspectionAfter int64
			var inspectionStatus string
			err = tx.QueryRow("SELECT q.failed_quantity,q.passed_quantity,q.sample_quantity,q.status,q.rowid FROM mes_quality_checks q JOIN mes_finished_goods_batches b ON b.organization_id=q.organization_id AND b.work_order_id=q.work_order_id AND b.report_id=q.report_id WHERE b.organization_id=? AND b.id=? AND q.id=?", id.OrganizationID, entity, in.QualityCheckID).Scan(&failed, &passed, &sample, &inspectionStatus, &inspectionRow)
			if errors.Is(err, sql.ErrNoRows) {
				fail(w, 404, "Matching inspection not found")
				return
			}
			if err != nil {
				fail(w, 503, "Cannot read inspection")
				return
			}
			if err = tx.QueryRow("SELECT MAX(COALESCE((SELECT MAX(reinspection_after) FROM mes_finished_goods_quality_dispositions WHERE organization_id=? AND batch_id=? AND disposition='rework'),0),COALESCE((SELECT MAX(reinspection_after) FROM mes_finished_goods_resolutions WHERE organization_id=? AND batch_id=? AND disposition='rework'),0))", id.OrganizationID, entity, id.OrganizationID, entity).Scan(&reinspectionAfter); err != nil {
				fail(w, 503, "Cannot read rework history")
				return
			}
			if inspectionRow <= reinspectionAfter || sample < 1 || passed < 0 || failed < 0 || passed+failed != sample || (in.Disposition == "release" && (failed != 0 || inspectionStatus != "passed")) || (in.Disposition == "quarantine" && (failed == 0 || inspectionStatus != "quarantined")) {
				fail(w, 409, "Inspection does not permit this disposition")
				return
			}
			next := "released"
			if in.Disposition == "quarantine" {
				next = "quarantined"
			}
			_, err = tx.Exec("INSERT INTO mes_finished_goods_quality_dispositions(id,organization_id,batch_id,passed_quantity,failed_quantity,disposition,quality_check_id) VALUES(?,?,?,?,?,?,?)", "fgqc_"+token(), id.OrganizationID, entity, in.Passed, in.Failed, in.Disposition, in.QualityCheckID)
			if err == nil {
				_, err = tx.Exec("UPDATE mes_finished_goods_batches SET status=? WHERE organization_id=? AND id=?", next, id.OrganizationID, entity)
			}
			result["status"] = next
		} else {
			if in.Quantity < 1 || in.Quantity > 1000000 {
				fail(w, 400, "Invalid receipt quantity")
				return
			}
			if state != "released" || orderStatus != "completed" || in.Quantity != quantity {
				fail(w, 409, "Batch is not fully released")
				return
			}
			var productCount int
			if err = tx.QueryRow("SELECT count(*) FROM mes_products WHERE organization_id=? AND id=?", id.OrganizationID, productID).Scan(&productCount); err != nil {
				fail(w, 503, "Cannot verify product")
				return
			}
			if productCount != 1 {
				fail(w, 409, "Work order product is unavailable in this workspace")
				return
			}
			receiptID := "fgr_" + token()
			_, err = tx.Exec("INSERT INTO mes_finished_goods_receipts(id,organization_id,batch_id,quantity,idempotency_key) VALUES(?,?,?,?,?)", receiptID, id.OrganizationID, entity, in.Quantity, in.Key)
			if err == nil {
				_, err = tx.Exec("INSERT INTO mes_finished_goods_inventory(id,organization_id,batch_id,quantity_on_hand) VALUES(?,?,?,?)", "fgi_"+token(), id.OrganizationID, entity, in.Quantity)
			}
			if err == nil {
				_, err = tx.Exec("UPDATE mes_finished_goods_batches SET status='received' WHERE organization_id=? AND id=?", id.OrganizationID, entity)
			}
			if err == nil {
				eventID := "mes.received:" + receiptID
				event, marshalErr := json.Marshal(map[string]any{"eventId": eventID, "schemaVersion": 1, "organizationId": id.OrganizationID, "sourceReceiptId": receiptID, "batchId": entity, "mesProductId": productID, "quantity": in.Quantity, "occurredAt": time.Now().UTC().Format(time.RFC3339Nano)})
				if marshalErr != nil {
					err = marshalErr
				} else {
					_, err = tx.Exec("INSERT INTO outbox_events(id,organization_id,event_type,payload) VALUES(?,?,'mes.finished_goods.received',?)", eventID, id.OrganizationID, string(event))
				}
				result["eventId"] = eventID
			}
			result["status"] = "received"
		}
		if err != nil {
			fail(w, 409, "Cannot apply finished goods action")
			return
		}
		result["batchId"] = entity
	case "close":
		var state string
		var good, scrap, target int64
		err = tx.QueryRow("SELECT status,completed_quantity,scrapped_quantity,target_quantity FROM mes_work_orders WHERE organization_id=? AND id=?", id.OrganizationID, in.WorkOrderID).Scan(&state, &good, &scrap, &target)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 404, "Work order not found")
			return
		}
		if err != nil {
			fail(w, 503, "Cannot read work order")
			return
		}
		var received, pending int64
		err = tx.QueryRow("SELECT COALESCE(SUM(CASE WHEN status IN ('received','scrapped') THEN quantity ELSE 0 END),0),COALESCE(SUM(CASE WHEN status NOT IN ('received','scrapped') THEN 1 ELSE 0 END),0) FROM mes_finished_goods_batches WHERE organization_id=? AND work_order_id=?", id.OrganizationID, in.WorkOrderID).Scan(&received, &pending)
		if err != nil {
			fail(w, 503, "Cannot inspect batches")
			return
		}
		if state != "completed" || target < 1 || good < 0 || scrap < 0 || good+scrap != target || received != good || pending != 0 {
			fail(w, 409, "Finished goods are not fully received")
			return
		}
		_, err = tx.Exec("UPDATE mes_work_orders SET status='closed' WHERE organization_id=? AND id=? AND status='completed'", id.OrganizationID, in.WorkOrderID)
		if err != nil {
			fail(w, 503, "Cannot close work order")
			return
		}
		entity = in.WorkOrderID
		result["status"] = "closed"
	default:
		fail(w, 400, "Unknown finished goods action")
		return
	}
	encoded, _ := json.Marshal(result)
	_, err = tx.Exec("INSERT INTO idempotency_keys(id,organization_id,key,endpoint,request_hash,response_status,response_body) VALUES(?,?,?,?,?,200,?)", "idem_"+token(), id.OrganizationID, in.Key, endpoint, hash, string(encoded))
	if err == nil {
		_, err = tx.Exec("INSERT INTO audit_events(id,organization_id,actor_id,actor_role,action,entity_type,entity_id,after_value) VALUES(?,?,?,?,?,'mes_finished_goods',?,?)", "audit_"+token(), id.OrganizationID, id.UserID, g.Role, "mes.finished_goods."+in.Action, entity, string(encoded))
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 503, "Finished goods transaction failed")
		return
	}
	ok(w, result)
}