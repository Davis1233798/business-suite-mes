package main

import (
	"fmt"
	"sync"
	"testing"
)

func TestMESBOMCyclesAndConcurrentVersions(t *testing.T) {
	a := appForTest(t)
	space := token()
	org := "org_test_" + space
	admin := loginSite(t, a, "admin@suite.test", space, "mes")
	front := loginSite(t, a, "front@suite.test", space, "mes")
	viewer := loginSite(t, a, "viewer@suite.test", space, "mes")
	other := loginSite(t, a, "admin@suite.test", token(), "mes")
	path := "/api/stations/mes/bom"
	var product, sku string
	if e := a.db.QueryRow("SELECT id,sku FROM mes_products WHERE organization_id=? LIMIT 1", org).Scan(&product, &sku); e != nil {
		t.Fatal(e)
	}
	input := func(i int) map[string]any {
		return map[string]any{"productId": product, "version": 2, "items": []any{map[string]any{"materialSku": "RAW-NEW", "materialName": "Example material", "quantityPerUnit": 2}}, "idempotencyKey": fmt.Sprintf("bom-create-%08d", i)}
	}
	if w := request(a, "POST", path, input(99), front...); w.Code != 403 {
		t.Fatalf("front %d", w.Code)
	}
	if w := request(a, "POST", path, input(99), viewer...); w.Code != 403 {
		t.Fatalf("readonly %d", w.Code)
	}
	if w := request(a, "POST", path, input(99), other...); w.Code != 404 {
		t.Fatalf("foreign product %d", w.Code)
	}
	direct := map[string]any{"productId": product, "version": 3, "items": []any{map[string]any{"materialSku": sku, "materialName": "self", "quantityPerUnit": 1}}, "idempotencyKey": "bom-direct-cycle-01"}
	if w := request(a, "POST", path, direct, admin...); w.Code != 409 {
		t.Fatalf("direct cycle %d", w.Code)
	}
	sub, bom := "subproduct_"+token(), "subbom_"+token()
	a.db.Exec("INSERT INTO mes_products(id,organization_id,sku,name,status) VALUES(?,?,?,'Subproduct','active')", sub, org, "SUB-PRODUCT")
	a.db.Exec("INSERT INTO mes_bom_versions(id,organization_id,product_id,version,status,is_active) VALUES(?,?,?,1,'active',1)", bom, org, sub)
	a.db.Exec("INSERT INTO mes_bom_items(id,organization_id,bom_version_id,material_sku,material_name,quantity_per_unit) VALUES(?,?,?,?,?,1)", "subitem_"+token(), org, bom, sku, "Parent")
	indirect := map[string]any{"productId": product, "version": 3, "items": []any{map[string]any{"materialSku": "SUB-PRODUCT", "materialName": "sub", "quantityPerUnit": 1}}, "idempotencyKey": "bom-indirect-cycle-01"}
	if w := request(a, "POST", path, indirect, admin...); w.Code != 409 {
		t.Fatalf("indirect cycle %d %s", w.Code, w.Body.String())
	}
	var wg sync.WaitGroup
	type result struct{ code, index int }
	results := make(chan result, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); results <- result{request(a, "POST", path, input(i), admin...).Code, i} }(i)
	}
	wg.Wait()
	close(results)
	ok, conflicts, winner := 0, 0, 0
	for r := range results {
		if r.code == 200 {
			ok++
			winner = r.index
		} else if r.code == 409 {
			conflicts++
		} else {
			t.Errorf("BOM %d", r.code)
		}
	}
	if ok != 1 || conflicts != 11 {
		t.Fatalf("success %d conflict %d", ok, conflicts)
	}
	if w := request(a, "POST", path, input(winner), admin...); w.Code != 200 {
		t.Fatalf("replay %d", w.Code)
	}
	var versions, items int
	a.db.QueryRow("SELECT count(*) FROM mes_bom_versions WHERE organization_id=? AND product_id=? AND version=2", org, product).Scan(&versions)
	a.db.QueryRow("SELECT count(*) FROM mes_bom_items i JOIN mes_bom_versions b ON b.id=i.bom_version_id AND b.organization_id=i.organization_id WHERE b.organization_id=? AND b.product_id=? AND b.version=2", org, product).Scan(&items)
	if versions != 1 || items != 1 {
		t.Fatalf("versions %d items %d", versions, items)
	}
}
