package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

type mesOperationRequest struct {
	Action      string `json:"action"`
	WorkOrderID string `json:"workOrderId"`
	LotID       string `json:"lotId"`
	LotNumber   string `json:"lotNumber"`
	MaterialSKU string `json:"materialSku"`
	LotQuantity int64  `json:"lotQuantity"`
	Issued      int64  `json:"issued"`
	Returned    int64  `json:"returned"`
	ReportID    string `json:"reportId"`
	Sample      int64  `json:"sample"`
	Failed      int64  `json:"failed"`
	Disposition string `json:"disposition"`
	Notes       string `json:"notes"`
	CenterID    string `json:"centerId"`
	DowntimeID  string `json:"downtimeId"`
	Start       string `json:"start"`
	End         string `json:"end"`
	Reason      string `json:"reason"`
	Key         string `json:"idempotencyKey"`
}

func (a *App) mesOperations(w http.ResponseWriter, r *http.Request, id *Identity, g *Grant) {
	if r.Method != http.MethodPost {
		fail(w, 405, "Use POST")
		return
	}
	if g.Role == "readonly" {
		fail(w, 403, "A write-enabled role is required")
		return
	}
	var in mesOperationRequest
	if body(r, &in) != nil || len(in.Key) < 8 || len(in.Key) > 128 || len(in.WorkOrderID) > 256 || len(in.LotID) > 256 || len(in.ReportID) > 256 || len(in.CenterID) > 256 || len(in.DowntimeID) > 256 || len(in.Notes) > 500 || len(in.Reason) > 500 || (in.Action != "material" && in.Action != "quality" && in.Action != "downtime" && in.Action != "resolveDowntime" && in.Action != "createLot") {
		fail(w, 400, "Invalid MES request")
		return
	}
	in.Reason = strings.TrimSpace(in.Reason)
	in.LotNumber = strings.TrimSpace(in.LotNumber)
	in.MaterialSKU = strings.TrimSpace(in.MaterialSKU)
	if in.Action == "createLot" {
		if g.Scope != "back" {
			fail(w, 403, "Back-office access required")
			return
		}
		if in.LotNumber == "" || len(in.LotNumber) > 128 || in.MaterialSKU == "" || len(in.MaterialSKU) > 128 || in.LotQuantity < 1 || in.LotQuantity > 1000000 {
			fail(w, 400, "Enter valid lot details")
			return
		}
	}
	if in.Action == "material" && (in.WorkOrderID == "" || in.LotID == "" || in.Issued < 1 || in.Issued > 1000000 || in.Returned < 0 || in.Returned > in.Issued) {
		fail(w, 400, "Enter valid material quantities")
		return
	}
	if in.Action == "quality" && (in.WorkOrderID == "" || in.Sample < 1 || in.Sample > 1000000 || in.Failed < 0 || in.Failed > in.Sample || (in.Disposition != "" && in.Disposition != "quarantine" && in.Disposition != "release" && in.Disposition != "rework") || (in.Failed > 0 && in.Disposition == "release")) {
		fail(w, 400, "Enter valid quality quantities and disposition")
		return
	}
	var start, end time.Time
	var e error
	if in.Action == "resolveDowntime" {
		end, e = time.Parse(time.RFC3339, in.End)
		if in.DowntimeID == "" || e != nil {
			fail(w, 400, "Select an ongoing event and valid end time")
			return
		}
		in.End = end.UTC().Format(time.RFC3339Nano)
	}
	if in.Action == "downtime" {
		start, e = time.Parse(time.RFC3339, in.Start)
		if e != nil || in.CenterID == "" || in.Reason == "" {
			fail(w, 400, "Enter a valid center, start and reason")
			return
		}
		in.Start = start.UTC().Format(time.RFC3339Nano)
		if in.End != "" {
			end, e = time.Parse(time.RFC3339, in.End)
			if e != nil || !end.After(start) || end.Sub(start) > 365*24*time.Hour {
				fail(w, 400, "Invalid downtime end")
				return
			}
			in.End = end.UTC().Format(time.RFC3339Nano)
		}
	}
	tx, e := a.db.BeginTx(r.Context(), nil)
	if e != nil {
		fail(w, 503, "MES unavailable")
		return
	}
	defer tx.Rollback()
	raw, _ := json.Marshal(in)
	hash := digest(id.UserID + "\x00" + string(raw))
	endpoint := "/station/mes/" + in.Action
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
	entity := ""
	result := map[string]any{}
	switch in.Action {
	case "resolveDowntime":
		entity = in.DowntimeID
		var startText, status, center string
		e = tx.QueryRow("SELECT start_time,status,work_center_id FROM mes_downtime_events WHERE organization_id=? AND id=?", id.OrganizationID, entity).Scan(&startText, &status, &center)
		if errors.Is(e, sql.ErrNoRows) {
			fail(w, 404, "Downtime event not found")
			return
		}
		if e != nil {
			fail(w, 503, "Cannot read downtime event")
			return
		}
		if status != "ongoing" {
			fail(w, 409, "Downtime is already resolved")
			return
		}
		start, e = time.Parse(time.RFC3339, startText)
		if e != nil || !end.After(start) || end.Sub(start) > 365*24*time.Hour {
			fail(w, 400, "End time must follow start within one year")
			return
		}
		var overlaps int
		e = tx.QueryRow("SELECT count(*) FROM mes_downtime_events WHERE organization_id=? AND work_center_id=? AND id!=? AND (end_time IS NULL OR julianday(end_time)>julianday(?)) AND julianday(start_time)<julianday(?)", id.OrganizationID, center, entity, startText, in.End).Scan(&overlaps)
		if e != nil {
			fail(w, 503, "Cannot check downtime")
			return
		}
		if overlaps > 0 {
			fail(w, 409, "Resolved interval overlaps another event")
			return
		}
		minutes := int64((end.Sub(start) + 30*time.Second) / time.Minute)
		var update sql.Result
		update, e = tx.Exec("UPDATE mes_downtime_events SET end_time=?,duration_minutes=?,status='resolved' WHERE organization_id=? AND id=? AND status='ongoing' AND end_time IS NULL", in.End, minutes, id.OrganizationID, entity)
		if e == nil {
			var n int64
			n, e = update.RowsAffected()
			if e == nil && n != 1 {
				fail(w, 409, "Downtime changed; refresh and retry")
				return
			}
		}
		result = map[string]any{"downtimeId": entity, "status": "resolved", "durationMinutes": minutes}
	case "createLot":
		var count int
		e = tx.QueryRow("SELECT count(*) FROM mes_bom_items WHERE organization_id=? AND material_sku=?", id.OrganizationID, in.MaterialSKU).Scan(&count)
		if e != nil {
			fail(w, 503, "Cannot validate material")
			return
		}
		if count == 0 {
			fail(w, 404, "Material SKU is not in a BOM")
			return
		}
		e = tx.QueryRow("SELECT count(*) FROM mes_material_lots WHERE organization_id=? AND lower(lot_number)=lower(?)", id.OrganizationID, in.LotNumber).Scan(&count)
		if e != nil {
			fail(w, 503, "Cannot validate lot")
			return
		}
		if count > 0 {
			fail(w, 409, "Lot number already exists")
			return
		}
		entity = "lot_" + token()
		_, e = tx.Exec("INSERT INTO mes_material_lots(id,organization_id,lot_number,material_sku,initial_quantity,current_quantity,status) VALUES(?,?,?,?,?,?,'available')", entity, id.OrganizationID, in.LotNumber, in.MaterialSKU, in.LotQuantity, in.LotQuantity)
		result = map[string]any{"lotId": entity}
	case "material":
		var status, bom string
		var target int64
		e = tx.QueryRow("SELECT status,bom_version_id,target_quantity FROM mes_work_orders WHERE organization_id=? AND id=?", id.OrganizationID, in.WorkOrderID).Scan(&status, &bom, &target)
		if errors.Is(e, sql.ErrNoRows) {
			fail(w, 404, "Work order not found")
			return
		}
		if e != nil {
			fail(w, 503, "Cannot read work order")
			return
		}
		if status == "closed" || target < 1 || target > 1000000000 {
			fail(w, 409, "Work order cannot receive material")
			return
		}
		var sku, lotStatus string
		var available int64
		e = tx.QueryRow("SELECT material_sku,status,current_quantity FROM mes_material_lots WHERE organization_id=? AND id=?", id.OrganizationID, in.LotID).Scan(&sku, &lotStatus, &available)
		if errors.Is(e, sql.ErrNoRows) {
			fail(w, 404, "Material lot not found")
			return
		}
		if e != nil {
			fail(w, 503, "Cannot read lot")
			return
		}
		if lotStatus != "available" || available < in.Issued {
			fail(w, 409, "Material lot unavailable or insufficient")
			return
		}
		var matching int
		e = tx.QueryRow("SELECT count(*) FROM mes_bom_items WHERE organization_id=? AND bom_version_id=? AND material_sku=?", id.OrganizationID, bom, sku).Scan(&matching)
		if e != nil {
			fail(w, 503, "Cannot read BOM")
			return
		}
		if matching == 0 {
			fail(w, 409, "Material is not in this work order BOM")
			return
		}
		net := in.Issued - in.Returned
		entity = "material_" + token()
		_, e = tx.Exec("UPDATE mes_material_lots SET current_quantity=current_quantity-? WHERE organization_id=? AND id=? AND current_quantity>=?", net, id.OrganizationID, in.LotID, in.Issued)
		if e == nil {
			_, e = tx.Exec("INSERT INTO mes_work_order_materials(id,organization_id,work_order_id,material_lot_id,material_sku,issued_quantity,returned_quantity,net_quantity) VALUES(?,?,?,?,?,?,?,?)", entity, id.OrganizationID, in.WorkOrderID, in.LotID, sku, in.Issued, in.Returned, net)
		}
		if e == nil {
			_, e = tx.Exec("UPDATE mes_work_orders SET materials_staged=CASE WHEN NOT EXISTS (SELECT 1 FROM mes_bom_items b WHERE b.organization_id=? AND b.bom_version_id=? AND b.quantity_per_unit*? > COALESCE((SELECT SUM(m.net_quantity) FROM mes_work_order_materials m WHERE m.organization_id=? AND m.work_order_id=? AND m.material_sku=b.material_sku),0)) THEN 1 ELSE 0 END WHERE organization_id=? AND id=?", id.OrganizationID, bom, target, id.OrganizationID, in.WorkOrderID, id.OrganizationID, in.WorkOrderID)
		}
		result = map[string]any{"lotRemaining": available - net, "netQuantity": net}
	case "quality":
		var status string
		var good, scrap int64
		e = tx.QueryRow("SELECT status,completed_quantity,scrapped_quantity FROM mes_work_orders WHERE organization_id=? AND id=?", id.OrganizationID, in.WorkOrderID).Scan(&status, &good, &scrap)
		if errors.Is(e, sql.ErrNoRows) {
			fail(w, 404, "Work order not found")
			return
		}
		if e != nil {
			fail(w, 503, "Cannot read work order")
			return
		}
		if status == "closed" || in.Sample > good+scrap {
			fail(w, 409, "Sample exceeds reported production or order is closed")
			return
		}
		var report any = nil
		if in.ReportID != "" {
			var reported int64
			e = tx.QueryRow("SELECT good_quantity+scrap_quantity FROM mes_production_reports WHERE organization_id=? AND work_order_id=? AND id=?", id.OrganizationID, in.WorkOrderID, in.ReportID).Scan(&reported)
			if errors.Is(e, sql.ErrNoRows) {
				fail(w, 404, "Production report not found")
				return
			}
			if e != nil {
				fail(w, 503, "Cannot read report")
				return
			}
			if in.Sample > reported {
				fail(w, 409, "Sample exceeds production report")
				return
			}
			report = in.ReportID
		}
		qcStatus, disposition := "passed", "release"
		if in.Failed > 0 {
			qcStatus = "quarantined"
			disposition = in.Disposition
			if disposition == "" {
				disposition = "quarantine"
			}
		}
		entity = "quality_" + token()
		_, e = tx.Exec("INSERT INTO mes_quality_checks(id,organization_id,work_order_id,report_id,inspector_id,sample_quantity,passed_quantity,failed_quantity,status,disposition,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)", entity, id.OrganizationID, in.WorkOrderID, report, id.UserID, in.Sample, in.Sample-in.Failed, in.Failed, qcStatus, disposition, in.Notes)
		result = map[string]any{"qualityCheckId": entity, "status": qcStatus, "disposition": disposition, "passed": in.Sample - in.Failed, "failed": in.Failed}
	case "downtime":
		var found int
		e = tx.QueryRow("SELECT count(*) FROM mes_work_centers WHERE organization_id=? AND id=?", id.OrganizationID, in.CenterID).Scan(&found)
		if e != nil {
			fail(w, 503, "Cannot read work center")
			return
		}
		if found == 0 {
			fail(w, 404, "Work center not found")
			return
		}
		var endArg any = nil
		if in.End != "" {
			endArg = in.End
		}
		var overlaps int
		e = tx.QueryRow("SELECT count(*) FROM mes_downtime_events WHERE organization_id=? AND work_center_id=? AND (end_time IS NULL OR julianday(end_time)>julianday(?)) AND (? IS NULL OR julianday(start_time)<julianday(?))", id.OrganizationID, in.CenterID, in.Start, endArg, endArg).Scan(&overlaps)
		if e != nil {
			fail(w, 503, "Cannot check downtime")
			return
		}
		if overlaps > 0 {
			fail(w, 409, "Downtime overlaps an existing event")
			return
		}
		entity = "downtime_" + token()
		state := "ongoing"
		minutes := int64(0)
		if in.End != "" {
			state = "resolved"
			minutes = int64((end.Sub(start) + 30*time.Second) / time.Minute)
		}
		_, e = tx.Exec("INSERT INTO mes_downtime_events(id,organization_id,work_center_id,start_time,end_time,duration_minutes,reason,reporter_id,status) VALUES(?,?,?,?,?,?,?,?,?)", entity, id.OrganizationID, in.CenterID, in.Start, endArg, minutes, in.Reason, id.UserID, state)
		result = map[string]any{"downtimeId": entity, "status": state, "durationMinutes": minutes}
	}
	if e != nil {
		fail(w, 503, "Cannot save MES operation")
		return
	}
	encoded, _ := json.Marshal(result)
	_, e = tx.Exec("INSERT INTO idempotency_keys(id,organization_id,key,endpoint,request_hash,response_status,response_body) VALUES(?,?,?,?,?,200,?)", "idem_"+token(), id.OrganizationID, in.Key, endpoint, hash, string(encoded))
	if e == nil {
		_, e = tx.Exec("INSERT INTO audit_events(id,organization_id,actor_id,actor_role,action,entity_type,entity_id,after_value,reason) VALUES(?,?,?,?,?,'mes',?,?,?)", "audit_"+token(), id.OrganizationID, id.UserID, g.Role, "mes."+in.Action, entity, string(encoded), in.Reason)
	}
	if e != nil {
		fail(w, 503, "Cannot record MES operation")
		return
	}
	if tx.Commit() != nil {
		fail(w, 503, "Cannot commit MES operation")
		return
	}
	ok(w, result)
}