package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
)

// Invoked by the synthetic migration test with an imported database path.
// This exercises the real report handler against the actual migration output.
func TestMESImportedRetryReplay(t *testing.T) {
	dbPath := os.Getenv("MES_IMPORTED_RETRY_DB")
	if dbPath == "" {
		t.Skip("MES_IMPORTED_RETRY_DB is set by the synthetic migration test")
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	a := &App{db: db}
	identity := &Identity{UserID: "user-a", OrganizationID: "tenant-a"}
	grant := &Grant{Site: "mes", Role: "operator", Scope: "front", Enabled: true}
	path := "/api/stations/mes/business"
	key, notes := "report-retry-001", ""
	if os.Getenv("MES_IMPORTED_RETRY_LEGACY") == "1" {
		key, notes = "source-report-retry-001", "校驗 <&>"
	}
	input := map[string]any{"action": "report", "workOrderId": "wo-a", "operationId": "op-a", "goodQuantity": 4, "scrapQuantity": 0, "notes": notes, "idempotencyKey": key}
	var before int
	if err = db.QueryRow("SELECT count(*) FROM mes_production_reports WHERE idempotency_key=?", key).Scan(&before); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, path, mustJSONReader(t, input))
	r.Header.Set("Content-Type", "application/json")
	a.mesBusiness(w, r, identity, grant)
	if w.Code != http.StatusOK {
		t.Fatalf("same-key replay status=%d body=%s", w.Code, w.Body.String())
	}
	var payload struct {
		Data map[string]any `json:"data"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Data["reportId"] != "report-a" {
		t.Fatalf("replay returned wrong report: %v", payload.Data)
	}
	if payload.Data["totalCompleted"] != float64(4) || payload.Data["status"] != "in_progress" {
		t.Fatalf("replay returned wrong historical status and totals: %v", payload.Data)
	}
	w = httptest.NewRecorder()
	r = httptest.NewRequest(http.MethodPost, path, mustJSONReader(t, input))
	r.Header.Set("Content-Type", "application/json")
	a.mesBusiness(w, r, &Identity{UserID: "other-writer", OrganizationID: "tenant-a"}, grant)
	if w.Code != http.StatusConflict {
		t.Fatalf("changed-actor replay status=%d body=%s", w.Code, w.Body.String())
	}
	input["goodQuantity"] = 3
	w = httptest.NewRecorder()
	r = httptest.NewRequest(http.MethodPost, path, mustJSONReader(t, input))
	r.Header.Set("Content-Type", "application/json")
	a.mesBusiness(w, r, identity, grant)
	if w.Code != http.StatusConflict {
		t.Fatalf("changed-payload replay status=%d body=%s", w.Code, w.Body.String())
	}
	var after int
	if err = db.QueryRow("SELECT count(*) FROM mes_production_reports WHERE idempotency_key=?", key).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("replay created report: before=%d after=%d", before, after)
	}
}

func mustJSONReader(t *testing.T, value any) *bytes.Reader {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(body)
}

func TestMESBusinessReportRaceIsAtomicAndTenantScoped(t *testing.T) {
	a := appForTest(t)
	space := token()
	org := "org_test_" + space
	admin := loginSite(t, a, "admin@suite.test", space, "mes")
	front := loginSite(t, a, "front@suite.test", space, "mes")
	readonly := loginSite(t, a, "viewer@suite.test", space, "mes")
	foreign := loginSite(t, a, "admin@suite.test", token(), "mes")
	var workOrder, operation string
	var target int
	if err := a.db.QueryRow(`SELECT w.id,w.target_quantity,o.id FROM mes_work_orders w JOIN mes_operations o ON o.organization_id=w.organization_id AND o.work_order_id=w.id WHERE w.organization_id=? AND w.status='released' AND w.materials_staged=1 AND w.completed_quantity=0 AND w.scrapped_quantity=0 ORDER BY o.sequence LIMIT 1`, org).Scan(&workOrder, &target, &operation); err != nil {
		t.Fatal(err)
	}
	path := "/api/stations/mes/business"
	if w := request(a, http.MethodPost, path, map[string]any{"action": "start", "workOrderId": workOrder}, front...); w.Code != http.StatusForbidden {
		t.Fatalf("front start: %d", w.Code)
	}
	if err := stageLabMaterials(context.Background(), a.db, org, workOrder, target); err != nil {
		t.Fatalf("prepare test BOM materials: %v", err)
	}
	if w := request(a, http.MethodPost, path, map[string]any{"action": "start", "workOrderId": workOrder}, admin...); w.Code != http.StatusOK {
		t.Fatalf("start: %d %s", w.Code, w.Body.String())
	}
	if w := request(a, http.MethodPost, path, map[string]any{"action": "report", "workOrderId": workOrder, "operationId": operation, "goodQuantity": target, "idempotencyKey": "foreign-report-0001"}, foreign...); w.Code != http.StatusNotFound {
		t.Fatalf("foreign tenant report: %d", w.Code)
	}
	const contenders = 32
	statuses := make(chan int, contenders)
	var wg sync.WaitGroup
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w := request(a, http.MethodPost, path, map[string]any{"action": "report", "workOrderId": workOrder, "operationId": operation, "goodQuantity": target, "scrapQuantity": 0, "idempotencyKey": fmt.Sprintf("mes-race-%s-%02d", space[:12], i)}, front...)
			statuses <- w.Code
		}(i)
	}
	wg.Wait()
	close(statuses)
	wins, conflicts := 0, 0
	for code := range statuses {
		if code == http.StatusOK {
			wins++
		} else if code == http.StatusConflict {
			conflicts++
		} else {
			t.Errorf("unexpected report status %d", code)
		}
	}
	if wins != 1 || conflicts != contenders-1 {
		t.Fatalf("success=%d conflicts=%d", wins, conflicts)
	}
	var state string
	var completed, reports, audits, events, reportGood, reportScrap int
	if err := a.db.QueryRow(`SELECT status,completed_quantity FROM mes_work_orders WHERE organization_id=? AND id=?`, org, workOrder).Scan(&state, &completed); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow(`SELECT count(*) FROM mes_production_reports WHERE organization_id=? AND work_order_id=?`, org, workOrder).Scan(&reports); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow(`SELECT COALESCE(SUM(good_quantity),0),COALESCE(SUM(scrap_quantity),0) FROM mes_production_reports WHERE organization_id=? AND work_order_id=?`, org, workOrder).Scan(&reportGood, &reportScrap); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow(`SELECT count(*) FROM audit_events WHERE organization_id=? AND entity_id=?`, org, workOrder).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow(`SELECT count(*) FROM outbox_events WHERE organization_id=? AND event_type='mes.work-order.changed' AND json_extract(payload,'$.workOrderId')=?`, org, workOrder).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if state != "completed" || completed != target || reports != 1 || reportGood != completed || reportScrap != 0 || audits < 2 || events < 2 {
		t.Fatalf("business state=%s completed=%d target=%d reports=%d reportGood=%d reportScrap=%d audits=%d events=%d", state, completed, target, reports, reportGood, reportScrap, audits, events)
	}
	var key string
	if err := a.db.QueryRow(`SELECT idempotency_key FROM mes_production_reports WHERE organization_id=? AND work_order_id=?`, org, workOrder).Scan(&key); err != nil {
		t.Fatal(err)
	}
	replayBody := map[string]any{"action": "report", "workOrderId": workOrder, "operationId": operation, "goodQuantity": target, "idempotencyKey": key}
	var first, replay struct {
		Data map[string]any `json:"data"`
	}
	w := request(a, http.MethodPost, path, replayBody, front...)
	json.Unmarshal(w.Body.Bytes(), &first)
	w = request(a, http.MethodPost, path, replayBody, front...)
	json.Unmarshal(w.Body.Bytes(), &replay)
	if w.Code != http.StatusOK || first.Data["reportId"] != replay.Data["reportId"] {
		t.Fatalf("retry did not replay: %d %s", w.Code, w.Body.String())
	}
	replayBody["goodQuantity"] = 1
	if w = request(a, http.MethodPost, path, replayBody, front...); w.Code != http.StatusConflict {
		t.Fatalf("changed retry payload: %d", w.Code)
	}
	if err := a.db.QueryRow(`SELECT count(*) FROM mes_production_reports WHERE organization_id=? AND work_order_id=?`, org, workOrder).Scan(&reports); err != nil || reports != 1 {
		t.Fatalf("changed retry payload mutated report rows: reports=%d err=%v", reports, err)
	}
	if w = request(a, http.MethodPost, path, map[string]any{"action": "report", "workOrderId": workOrder, "operationId": operation, "goodQuantity": 1, "idempotencyKey": "readonly-report-0001"}, readonly...); w.Code != http.StatusForbidden {
		t.Fatalf("readonly report: %d", w.Code)
	}
}
