package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func TestMESAddOperationValidationAndIdempotency(t *testing.T) {
	a := appForTest(t)
	space := token()
	org := "org_test_" + space
	admin := loginSite(t, a, "admin@suite.test", space, "mes")
	front := loginSite(t, a, "front@suite.test", space, "mes")
	foreign := loginSite(t, a, "admin@suite.test", token(), "mes")

	var product, bom, center string
	if err := a.db.QueryRow("SELECT product_id,id FROM mes_bom_versions WHERE organization_id=? AND is_active=1 LIMIT 1", org).Scan(&product, &bom); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow("SELECT id FROM mes_work_centers WHERE organization_id=? AND status='active' LIMIT 1", org).Scan(&center); err != nil {
		t.Fatal(err)
	}

	// 1. Create a work order first
	createPath := "/api/stations/mes/work-orders"
	createInput := map[string]any{
		"productId":      product,
		"bomId":          bom,
		"centerId":       center,
		"orderNumber":    "WO-MULTI-01",
		"operationName":  "Initial Machining",
		"target":         10,
		"minutes":        2,
		"idempotencyKey": "wo-multi-order-001",
	}
	w := request(a, http.MethodPost, createPath, createInput, admin...)
	if w.Code != http.StatusOK {
		t.Fatalf("create work order failed: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		Data struct {
			WorkOrderID string `json:"workOrderId"`
			OperationID string `json:"operationId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	woID := created.Data.WorkOrderID

	// 2. Add operation validation
	addInput := func(seq int, name string, key string) map[string]any {
		return map[string]any{
			"action":         "addOperation",
			"workOrderId":    woID,
			"centerId":       center,
			"sequence":       seq,
			"operationName":  name,
			"minutes":        3,
			"idempotencyKey": key,
		}
	}

	// Non-backoffice role should fail (403)
	if w := request(a, http.MethodPost, createPath, addInput(20, "Assembly", "op-idem-001"), front...); w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for front-office add operation, got %d", w.Code)
	}

	// Foreign tenant should fail (404)
	if w := request(a, http.MethodPost, createPath, addInput(20, "Assembly", "op-idem-001"), foreign...); w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for foreign tenant, got %d", w.Code)
	}

	// Duplicate sequence (Sequence 10 already created with work order) should fail (409)
	if w := request(a, http.MethodPost, createPath, addInput(10, "Duplicate Sequence", "op-idem-002"), admin...); w.Code != http.StatusConflict {
		t.Fatalf("expected 409 for duplicate sequence 10, got %d", w.Code)
	}

	// Invalid empty name should fail (400)
	invalidName := addInput(20, "   ", "op-idem-003")
	if w := request(a, http.MethodPost, createPath, invalidName, admin...); w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty name, got %d", w.Code)
	}

	// Successful creation of Sequence 20
	successW := request(a, http.MethodPost, createPath, addInput(20, "Secondary Assembly", "op-idem-004"), admin...)
	if successW.Code != http.StatusOK {
		t.Fatalf("expected 200 for valid addOperation, got %d %s", successW.Code, successW.Body.String())
	}
	var opResp struct {
		Data struct {
			WorkOrderID string `json:"workOrderId"`
			OperationID string `json:"operationId"`
			Sequence    int    `json:"sequence"`
			Status      string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(successW.Body.Bytes(), &opResp); err != nil {
		t.Fatal(err)
	}
	if opResp.Data.OperationID == "" || opResp.Data.Sequence != 20 || opResp.Data.Status != "pending" {
		t.Fatalf("unexpected addOperation response: %+v", opResp.Data)
	}

	// Idempotent replay with same key returns 200 and same operation ID
	replayW := request(a, http.MethodPost, createPath, addInput(20, "Secondary Assembly", "op-idem-004"), admin...)
	if replayW.Code != http.StatusOK {
		t.Fatalf("expected 200 for idempotent replay, got %d", replayW.Code)
	}
	var replayResp struct {
		Data struct {
			OperationID string `json:"operationId"`
		} `json:"data"`
	}
	json.Unmarshal(replayW.Body.Bytes(), &replayResp)
	if replayResp.Data.OperationID != opResp.Data.OperationID {
		t.Fatalf("replay operation ID mismatch: got %s want %s", replayResp.Data.OperationID, opResp.Data.OperationID)
	}

	// Idempotency replay with altered payload returns 409 Conflict
	tampered := addInput(20, "Altered Assembly Name", "op-idem-004")
	if w := request(a, http.MethodPost, createPath, tampered, admin...); w.Code != http.StatusConflict {
		t.Fatalf("expected 409 for tampered idempotency payload, got %d", w.Code)
	}
}

func TestMESMultiOperationSequentialEnforcement(t *testing.T) {
	a := appForTest(t)
	space := token()
	org := "org_test_" + space
	admin := loginSite(t, a, "admin@suite.test", space, "mes")
	front := loginSite(t, a, "front@suite.test", space, "mes")

	var product, bom, center string
	if err := a.db.QueryRow("SELECT product_id,id FROM mes_bom_versions WHERE organization_id=? AND is_active=1 LIMIT 1", org).Scan(&product, &bom); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow("SELECT id FROM mes_work_centers WHERE organization_id=? AND status='active' LIMIT 1", org).Scan(&center); err != nil {
		t.Fatal(err)
	}

	// Create work order with target 10 (Sequence 10 operation automatically created)
	targetQty := 10
	createPath := "/api/stations/mes/work-orders"
	createInput := map[string]any{
		"productId":      product,
		"bomId":          bom,
		"centerId":       center,
		"orderNumber":    "WO-MULTI-SEQ-01",
		"operationName":  "Op 10 Machining",
		"target":         targetQty,
		"minutes":        2,
		"idempotencyKey": "wo-seq-order-001",
	}
	w := request(a, http.MethodPost, createPath, createInput, admin...)
	if w.Code != http.StatusOK {
		t.Fatalf("create work order failed: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		Data struct {
			WorkOrderID string `json:"workOrderId"`
			OperationID string `json:"operationId"`
		} `json:"data"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)
	woID := created.Data.WorkOrderID
	op10ID := created.Data.OperationID

	// Add Sequence 20 (Assembly)
	w20 := request(a, http.MethodPost, createPath, map[string]any{
		"action":         "addOperation",
		"workOrderId":    woID,
		"centerId":       center,
		"sequence":       20,
		"operationName":  "Op 20 Assembly",
		"minutes":        3,
		"idempotencyKey": "wo-seq-op-020",
	}, admin...)
	if w20.Code != http.StatusOK {
		t.Fatalf("failed to add op 20: %d %s", w20.Code, w20.Body.String())
	}
	var resp20 struct {
		Data struct {
			OperationID string `json:"operationId"`
		} `json:"data"`
	}
	json.Unmarshal(w20.Body.Bytes(), &resp20)
	op20ID := resp20.Data.OperationID

	// Stage materials and start work order
	if err := stageLabMaterials(context.Background(), a.db, org, woID, targetQty); err != nil {
		t.Fatalf("stage materials failed: %v", err)
	}
	if _, err := a.db.Exec("UPDATE mes_work_orders SET materials_staged=1 WHERE id=?", woID); err != nil {
		t.Fatalf("update materials_staged failed: %v", err)
	}
	startW := request(a, http.MethodPost, "/api/stations/mes/business", map[string]any{
		"action":      "start",
		"workOrderId": woID,
	}, admin...)
	if startW.Code != http.StatusOK {
		t.Fatalf("start work order failed: %d %s", startW.Code, startW.Body.String())
	}

	businessPath := "/api/stations/mes/business"

	// 1. Attempt to report on Op 20 before Op 10 has produced anything -> 409 Conflict
	earlyOp20 := request(a, http.MethodPost, businessPath, map[string]any{
		"action":         "report",
		"workOrderId":    woID,
		"operationId":    op20ID,
		"goodQuantity":   2,
		"scrapQuantity":  0,
		"idempotencyKey": "early-op20-report-01",
	}, front...)
	if earlyOp20.Code != http.StatusConflict {
		t.Fatalf("expected 409 for Op 20 reporting before Op 10, got %d %s", earlyOp20.Code, earlyOp20.Body.String())
	}

	// 2. Report on Op 10: 6 good, 1 scrap (total 7 out of 10)
	op10Report1 := request(a, http.MethodPost, businessPath, map[string]any{
		"action":         "report",
		"workOrderId":    woID,
		"operationId":    op10ID,
		"goodQuantity":   6,
		"scrapQuantity":  1,
		"idempotencyKey": "op10-report-01",
	}, front...)
	if op10Report1.Code != http.StatusOK {
		t.Fatalf("expected 200 for Op 10 report, got %d %s", op10Report1.Code, op10Report1.Body.String())
	}

	// Verify Op 10 status is in_progress
	var op10Status string
	a.db.QueryRow("SELECT status FROM mes_operations WHERE id=?", op10ID).Scan(&op10Status)
	if op10Status != "in_progress" {
		t.Fatalf("expected op10 in_progress, got %s", op10Status)
	}

	// Check work order state: completed quantity is 6 (from Op 10 so far), scrap is 1
	var woCompleted, woScrap int
	a.db.QueryRow("SELECT completed_quantity, scrapped_quantity FROM mes_work_orders WHERE id=?", woID).Scan(&woCompleted, &woScrap)
	if woCompleted != 6 {
		t.Fatalf("expected woCompleted 6 from op10 so far, got %d", woCompleted)
	}
	if woScrap != 1 {
		t.Fatalf("expected woScrap 1 from op10 scrap, got %d", woScrap)
	}

	// 3. Attempt to report on Op 20 with 7 good -> exceeds Op 10's completed good of 6 -> 409 Conflict
	excessOp20 := request(a, http.MethodPost, businessPath, map[string]any{
		"action":         "report",
		"workOrderId":    woID,
		"operationId":    op20ID,
		"goodQuantity":   7,
		"scrapQuantity":  0,
		"idempotencyKey": "excess-op20-report-01",
	}, front...)
	if excessOp20.Code != http.StatusConflict {
		t.Fatalf("expected 409 when Op 20 exceeds Op 10 good output, got %d", excessOp20.Code)
	}

	// 4. Report on Op 20: 5 good, 1 scrap (total 6, matches Op 10 good output of 6)
	op20Report1 := request(a, http.MethodPost, businessPath, map[string]any{
		"action":         "report",
		"workOrderId":    woID,
		"operationId":    op20ID,
		"goodQuantity":   5,
		"scrapQuantity":  1,
		"idempotencyKey": "op20-report-01",
	}, front...)
	if op20Report1.Code != http.StatusOK {
		t.Fatalf("expected 200 for Op 20 report, got %d %s", op20Report1.Code, op20Report1.Body.String())
	}

	// Since Op 20 is the terminal operation, work order completed_quantity should now be 5!
	a.db.QueryRow("SELECT completed_quantity, scrapped_quantity FROM mes_work_orders WHERE id=?", woID).Scan(&woCompleted, &woScrap)
	if woCompleted != 5 {
		t.Fatalf("expected terminal op20 to update completed_quantity to 5, got %d", woCompleted)
	}
	if woScrap != 2 {
		t.Fatalf("expected total woScrap 2 (1 from op10 + 1 from op20), got %d", woScrap)
	}

	// 5. Complete the remaining 3 units on Op 10 (3 good, 0 scrap)
	op10Report2 := request(a, http.MethodPost, businessPath, map[string]any{
		"action":         "report",
		"workOrderId":    woID,
		"operationId":    op10ID,
		"goodQuantity":   3,
		"scrapQuantity":  0,
		"idempotencyKey": "op10-report-02",
	}, front...)
	if op10Report2.Code != http.StatusOK {
		t.Fatalf("expected 200 for Op 10 second report, got %d %s", op10Report2.Code, op10Report2.Body.String())
	}

	// Op 10 processed total 7 + 3 = 10 == target -> Op 10 status should be 'completed'
	a.db.QueryRow("SELECT status FROM mes_operations WHERE id=?", op10ID).Scan(&op10Status)
	if op10Status != "completed" {
		t.Fatalf("expected op10 completed, got %s", op10Status)
	}

	// 6. Complete remaining 3 units on Op 20 (3 good, 0 scrap)
	op20Report2 := request(a, http.MethodPost, businessPath, map[string]any{
		"action":         "report",
		"workOrderId":    woID,
		"operationId":    op20ID,
		"goodQuantity":   3,
		"scrapQuantity":  0,
		"idempotencyKey": "op20-report-02",
	}, front...)
	if op20Report2.Code != http.StatusOK {
		t.Fatalf("expected 200 for Op 20 second report, got %d %s", op20Report2.Code, op20Report2.Body.String())
	}

	// Op 20 status should now be 'completed'
	var op20Status string
	a.db.QueryRow("SELECT status FROM mes_operations WHERE id=?", op20ID).Scan(&op20Status)
	if op20Status != "completed" {
		t.Fatalf("expected op20 completed, got %s", op20Status)
	}

	// Work order status should now be 'completed' (completed 8 + scrapped 2 = target 10)
	var woStatus string
	a.db.QueryRow("SELECT status, completed_quantity, scrapped_quantity FROM mes_work_orders WHERE id=?", woID).Scan(&woStatus, &woCompleted, &woScrap)
	if woStatus != "completed" || woCompleted != 8 || woScrap != 2 {
		t.Fatalf("expected work order completed with 8 good, 2 scrap, got status=%s good=%d scrap=%d", woStatus, woCompleted, woScrap)
	}
}

func TestMESOEEComputationAndZeroDenominator(t *testing.T) {
	a := appForTest(t)
	space := token()
	admin := loginSite(t, a, "admin@suite.test", space, "mes")

	// Standard M08 fixture:
	// planned: 480m, operating: 360m, ideal cycle: 1m/piece, total: 300, good: 270
	// Availability = 75%, Performance = 83.3333%, Quality = 90%, OEE = 56.25%
	oeePath := "/api/stations/mes/oee?plannedMinutes=480&operatingMinutes=360&idealCycleMinutes=1&totalPieces=300&goodPieces=270"
	w := request(a, http.MethodGet, oeePath, nil, admin...)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for OEE query, got %d %s", w.Code, w.Body.String())
	}
	var oeeResp struct {
		Data struct {
			HasData             bool     `json:"hasData"`
			AvailabilityPercent *float64 `json:"availabilityPercent"`
			PerformancePercent  *float64 `json:"performancePercent"`
			QualityPercent      *float64 `json:"qualityPercent"`
			OeePercent          *float64 `json:"oeePercent"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &oeeResp); err != nil {
		t.Fatal(err)
	}
	if !oeeResp.Data.HasData {
		t.Fatal("expected hasData true")
	}
	if oeeResp.Data.AvailabilityPercent == nil || *oeeResp.Data.AvailabilityPercent != 75.0 {
		t.Fatalf("expected availability 75.0, got %v", oeeResp.Data.AvailabilityPercent)
	}
	if oeeResp.Data.PerformancePercent == nil || fmt.Sprintf("%.3f", *oeeResp.Data.PerformancePercent) != "83.333" {
		t.Fatalf("expected performance 83.333, got %v", oeeResp.Data.PerformancePercent)
	}
	if oeeResp.Data.QualityPercent == nil || *oeeResp.Data.QualityPercent != 90.0 {
		t.Fatalf("expected quality 90.0, got %v", oeeResp.Data.QualityPercent)
	}
	if oeeResp.Data.OeePercent == nil || *oeeResp.Data.OeePercent != 56.25 {
		t.Fatalf("expected OEE 56.25, got %v", oeeResp.Data.OeePercent)
	}

	// Zero denominator test:
	zeroPath := "/api/stations/mes/oee?plannedMinutes=0&operatingMinutes=0&idealCycleMinutes=0&totalPieces=0&goodPieces=0"
	wZero := request(a, http.MethodGet, zeroPath, nil, admin...)
	if wZero.Code != http.StatusOK {
		t.Fatalf("expected 200 for zero denominator, got %d", wZero.Code)
	}
	var zeroResp struct {
		Data struct {
			HasData    bool     `json:"hasData"`
			OeePercent *float64 `json:"oeePercent"`
		} `json:"data"`
	}
	json.Unmarshal(wZero.Body.Bytes(), &zeroResp)
	if zeroResp.Data.HasData || zeroResp.Data.OeePercent != nil {
		t.Fatalf("expected hasData false and nil oee for zero denominator, got %+v", zeroResp.Data)
	}
}
