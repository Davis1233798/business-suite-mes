package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type bomItem struct {
	SKU      string `json:"materialSku"`
	Name     string `json:"materialName"`
	Quantity int64  `json:"quantityPerUnit"`
}
type bomRequest struct {
	ProductID string    `json:"productId"`
	Version   int       `json:"version"`
	Items     []bomItem `json:"items"`
	Notes     string    `json:"notes"`
	Key       string    `json:"idempotencyKey"`
}

func (a *App) mesBOM(w http.ResponseWriter, r *http.Request, id *Identity, g *Grant) {
	if r.Method != http.MethodPost {
		fail(w, 405, "Use POST")
		return
	}
	if g.Role == "readonly" || g.Scope != "back" {
		fail(w, 403, "Write-enabled back-office access required")
		return
	}
	var in bomRequest
	if body(r, &in) != nil || len(in.Key) < 8 || len(in.Key) > 128 || in.ProductID == "" || len(in.ProductID) > 256 || in.Version < 1 || in.Version > 1000000 || len(in.Items) < 1 || len(in.Items) > 100 || len(in.Notes) > 500 {
		fail(w, 400, "Invalid BOM details")
		return
	}
	seen := map[string]bool{}
	for i := range in.Items {
		item := &in.Items[i]
		item.SKU = strings.TrimSpace(item.SKU)
		item.Name = strings.TrimSpace(item.Name)
		if item.SKU == "" || len(item.SKU) > 128 || item.Name == "" || len(item.Name) > 200 || item.Quantity < 1 || item.Quantity > 1000000 || seen[item.SKU] {
			fail(w, 400, "Invalid or duplicate BOM item")
			return
		}
		seen[item.SKU] = true
	}
	tx, e := a.db.BeginTx(r.Context(), nil)
	if e != nil {
		fail(w, 503, "MES unavailable")
		return
	}
	defer tx.Rollback()
	raw, _ := json.Marshal(in)
	hash := digest(id.UserID + "\x00" + string(raw))
	const endpoint = "/station/mes/bom/create"
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
	var productSKU string
	e = tx.QueryRow("SELECT sku FROM mes_products WHERE organization_id=? AND id=? AND status='active'", id.OrganizationID, in.ProductID).Scan(&productSKU)
	if errors.Is(e, sql.ErrNoRows) {
		fail(w, 404, "Active product not found")
		return
	}
	if e != nil {
		fail(w, 503, "Cannot read product")
		return
	}
	var count int
	e = tx.QueryRow("SELECT count(*) FROM mes_bom_versions WHERE organization_id=? AND product_id=? AND version=?", id.OrganizationID, in.ProductID, in.Version).Scan(&count)
	if e != nil {
		fail(w, 503, "Cannot read BOM versions")
		return
	}
	if count > 0 {
		fail(w, 409, "BOM version already exists")
		return
	}
	for _, item := range in.Items {
		e = tx.QueryRow(`WITH RECURSIVE dependencies(sku) AS (SELECT ? UNION SELECT bi.material_sku FROM dependencies d JOIN mes_products p ON p.sku=d.sku AND p.organization_id=? JOIN mes_bom_versions b ON b.product_id=p.id AND b.organization_id=p.organization_id AND b.is_active=1 JOIN mes_bom_items bi ON bi.bom_version_id=b.id AND bi.organization_id=b.organization_id) SELECT count(*) FROM dependencies WHERE sku=?`, item.SKU, id.OrganizationID, productSKU).Scan(&count)
		if e != nil {
			fail(w, 503, "Cannot validate BOM dependencies")
			return
		}
		if count > 0 {
			fail(w, 409, "BOM would create a circular dependency")
			return
		}
	}
	bom := "bom_" + token()
	_, e = tx.Exec("INSERT INTO mes_bom_versions(id,organization_id,product_id,version,status,is_active,notes) VALUES(?,?,?,?,'active',1,?)", bom, id.OrganizationID, in.ProductID, in.Version, in.Notes)
	for _, item := range in.Items {
		if e != nil {
			break
		}
		_, e = tx.Exec("INSERT INTO mes_bom_items(id,organization_id,bom_version_id,material_sku,material_name,quantity_per_unit) VALUES(?,?,?,?,?,?)", "bom_item_"+token(), id.OrganizationID, bom, item.SKU, item.Name, item.Quantity)
	}
	result := map[string]any{"bomId": bom, "version": in.Version}
	encoded, _ := json.Marshal(result)
	if e == nil {
		_, e = tx.Exec("INSERT INTO idempotency_keys(id,organization_id,key,endpoint,request_hash,response_status,response_body) VALUES(?,?,?,?,?,200,?)", "idem_"+token(), id.OrganizationID, in.Key, endpoint, hash, string(encoded))
	}
	if e == nil {
		_, e = tx.Exec("INSERT INTO audit_events(id,organization_id,actor_id,actor_role,action,entity_type,entity_id,after_value) VALUES(?,?,?,?,'mes.bom.create','mes_bom',?,?)", "audit_"+token(), id.OrganizationID, id.UserID, g.Role, bom, string(encoded))
	}
	if e != nil {
		fail(w, 503, "Cannot save BOM")
		return
	}
	if tx.Commit() != nil {
		fail(w, 503, "Cannot commit BOM")
		return
	}
	ok(w, result)
}
