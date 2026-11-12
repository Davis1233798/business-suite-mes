package main

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

func TestMESWorkOrderCreateAndStage(t *testing.T) {
	a := appForTest(t)
	space := token()
	org := "org_test_" + space
	admin := loginSite(t, a, "admin@suite.test", space, "mes")
	front := loginSite(t, a, "front@suite.test", space, "mes")
	other := loginSite(t, a, "admin@suite.test", token(), "mes")
	var product, bom, center string
	if e := a.db.QueryRow("SELECT product_id,id FROM mes_bom_versions WHERE organization_id=? AND is_active=1 LIMIT 1", org).Scan(&product, &bom); e != nil {
		t.Fatal(e)
	}
	a.db.QueryRow("SELECT id FROM mes_work_centers WHERE organization_id=? AND status='active' LIMIT 1", org).Scan(&center)
	path := "/api/stations/mes/work-orders"
	input := func(i int) map[string]any {
		return map[string]any{"productId": product, "bomId": bom, "centerId": center, "orderNumber": "WO-DEMO-NEW", "operationName": "Assembly", "target": 2, "minutes": 3, "idempotencyKey": fmt.Sprintf("mes-order-%08d", i)}
	}
	if w := request(a, "POST", path, input(99), front...); w.Code != 403 {
		t.Fatalf("front %d", w.Code)
	}
	if w := request(a, "POST", path, input(99), other...); w.Code != 404 {
		t.Fatalf("foreign %d", w.Code)
	}
	var wg sync.WaitGroup
	type result struct {
		code, index int
		body        []byte
	}
	results := make(chan result, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w := request(a, "POST", path, input(i), admin...)
			results <- result{w.Code, i, w.Body.Bytes()}
		}(i)
	}
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	var winner result
	for r := range results {
		if r.code == 200 {
			success++
			winner = r
		} else if r.code == 409 {
			conflicts++
		} else {
			t.Errorf("create %d %s", r.code, r.body)
		}
	}
	if success != 1 || conflicts != 11 {
		t.Fatalf("success %d conflict %d", success, conflicts)
	}
	if w := request(a, "POST", path, input(winner.index), admin...); w.Code != 200 {
		t.Fatalf("replay %d", w.Code)
	}
	var v struct {
		Data struct {
			ID        string `json:"workOrderId"`
			Operation string `json:"operationId"`
		} `json:"data"`
	}
	json.Unmarshal(winner.body, &v)
	if v.Data.ID == "" || v.Data.Operation == "" {
		t.Fatal("missing order or operation")
	}
	start := map[string]any{"action": "start", "workOrderId": v.Data.ID}
	if w := request(a, "POST", "/api/stations/mes/business", start, admin...); w.Code != 409 {
		t.Fatalf("started without materials %d", w.Code)
	}
	var lot string
	a.db.QueryRow("SELECT id FROM mes_material_lots WHERE organization_id=? AND material_sku='RAW-ALUM-6061'", org).Scan(&lot)
	issue := func(lotID string, qty int, key string) int {
		return request(a, "POST", "/api/stations/mes/operations", map[string]any{"action": "material", "workOrderId": v.Data.ID, "lotId": lotID, "issued": qty, "returned": 0, "idempotencyKey": key}, front...).Code
	}
	if code := issue(lot, 4, "new-order-material-01"); code != 200 {
		t.Fatalf("first material %d", code)
	}
	a.db.Exec("INSERT INTO mes_material_lots(id,organization_id,lot_number,material_sku,initial_quantity,current_quantity,status) VALUES(?,?,?,'RAW-THERMAL-PASTE',2,2,'available')", "test-lot-"+space, org, "test-lot-"+space)
	if code := issue("test-lot-"+space, 2, "new-order-material-02"); code != 200 {
		t.Fatalf("second material %d", code)
	}
	if w := request(a, "POST", "/api/stations/mes/business", start, admin...); w.Code != 200 {
		t.Fatalf("start %d %s", w.Code, w.Body.String())
	}
}
