package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"sync"
	"time"
)

type businessLabResult struct {
	Site             string  `json:"site"`
	Attempted        int     `json:"attempted"`
	Succeeded        int     `json:"succeeded"`
	Conflicts        int     `json:"conflicts"`
	Unknown          int     `json:"unknown"`
	Failed           int     `json:"failed"`
	Reconciled       bool    `json:"reconciled"`
	Valid            bool    `json:"valid"`
	BusinessRows     int     `json:"businessRows"`
	AuditRows        int     `json:"auditRows"`
	ProjectionEvents int     `json:"projectionEvents"`
	WorkOrderID      string  `json:"workOrderId"`
	WorkOrderNo      string  `json:"workOrderNo"`
	Target           int     `json:"target"`
	Completed        int     `json:"completed"`
	Scrapped         int     `json:"scrapped"`
	Remaining        int     `json:"remaining"`
	Status           string  `json:"status"`
	ElapsedMs        float64 `json:"elapsedMs"`
}

// stageLabMaterials makes the isolated seed order internally consistent before
// the lab calls the public start/report handlers. It never touches the service DB.
func stageLabMaterials(ctx context.Context, db *sql.DB, organizationID, workOrderID string, target int) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT b.material_sku,b.quantity_per_unit,COALESCE((SELECT SUM(m.net_quantity) FROM mes_work_order_materials m WHERE m.organization_id=b.organization_id AND m.work_order_id=? AND m.material_sku=b.material_sku),0) FROM mes_bom_items b JOIN mes_work_orders w ON w.organization_id=b.organization_id AND w.bom_version_id=b.bom_version_id WHERE w.organization_id=? AND w.id=?`, workOrderID, organizationID, workOrderID)
	if err != nil {
		return err
	}
	type item struct {
		sku              string
		required, staged int
	}
	items := []item{}
	for rows.Next() {
		var value item
		if err = rows.Scan(&value.sku, &value.required, &value.staged); err != nil {
			rows.Close()
			return err
		}
		value.required *= target
		items = append(items, value)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if len(items) == 0 {
		return errors.New("isolated work order has no BOM items")
	}
	for _, value := range items {
		missing := value.required - value.staged
		if missing <= 0 {
			continue
		}
		var lotID string
		var available int
		err = tx.QueryRowContext(ctx, "SELECT id,current_quantity FROM mes_material_lots WHERE organization_id=? AND material_sku=? AND status='available' AND current_quantity>=? ORDER BY current_quantity DESC,id LIMIT 1", organizationID, value.sku, missing).Scan(&lotID, &available)
		if errors.Is(err, sql.ErrNoRows) {
			lotID = "lab_lot_" + token()
			_, err = tx.ExecContext(ctx, "INSERT INTO mes_material_lots(id,organization_id,lot_number,material_sku,initial_quantity,current_quantity,status) VALUES(?,?,?,?,?,0,'depleted')", lotID, organizationID, "LAB-"+token()[:12], value.sku, missing)
		} else if err == nil {
			_, err = tx.ExecContext(ctx, "UPDATE mes_material_lots SET current_quantity=current_quantity-? WHERE organization_id=? AND id=? AND current_quantity>=?", missing, organizationID, lotID, missing)
		}
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO mes_work_order_materials(id,organization_id,work_order_id,material_lot_id,material_sku,issued_quantity,returned_quantity,net_quantity) VALUES(?,?,?,?,?,?,0,?)", "lab_issue_"+token(), organizationID, workOrderID, lotID, value.sku, missing, missing)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func businessLabRequest(ctx context.Context, app *App, method, path string, data any, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	b, _ := json.Marshal(data)
	req := httptest.NewRequest(method, "http://localhost"+path, bytes.NewReader(b)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	for _, c := range cookies {
		req.AddCookie(c)
	}
	out := httptest.NewRecorder()
	app.ServeHTTP(out, req)
	return out
}

func runMESBusinessLab(ctx context.Context, manager *businessLabManager, contenders int) (result businessLabResult, err error) {
	started := time.Now()
	if contenders < 2 || contenders > 32 {
		return result, errors.New("contenders must be between 2 and 32")
	}
	lab, err := manager.acquire(ctx)
	if err != nil {
		return result, err
	}
	defer func() { err = errors.Join(err, lab.close()) }()
	space := token()
	org := "org_test_" + space
	login := func(email string) ([]*http.Cookie, error) {
		out := businessLabRequest(ctx, lab.app, http.MethodPost, "/api/auth/login", map[string]string{"email": email, "password": testPassword, "site": "mes"}, &http.Cookie{Name: demoCookie, Value: space})
		if out.Code != http.StatusOK {
			return nil, fmt.Errorf("isolated login failed: %d", out.Code)
		}
		return out.Result().Cookies(), nil
	}
	admin, err := login("admin@suite.test")
	if err != nil {
		return result, err
	}
	operator, err := login("front@suite.test")
	if err != nil {
		return result, err
	}
	var orderID, orderNo, operationID string
	var target int
	err = lab.app.db.QueryRowContext(ctx, `SELECT w.id,w.order_no,w.target_quantity,o.id FROM mes_work_orders w JOIN mes_operations o ON o.organization_id=w.organization_id AND o.work_order_id=w.id WHERE w.organization_id=? AND w.status='released' AND w.materials_staged=1 AND w.completed_quantity=0 AND w.scrapped_quantity=0 ORDER BY w.id,o.sequence LIMIT 1`, org).Scan(&orderID, &orderNo, &target, &operationID)
	if err != nil {
		return result, fmt.Errorf("isolated staged work order unavailable: %w", err)
	}
	if err = stageLabMaterials(ctx, lab.app.db, org, orderID, target); err != nil {
		return result, fmt.Errorf("could not prepare isolated BOM materials: %w", err)
	}
	start := businessLabRequest(ctx, lab.app, http.MethodPost, "/api/stations/mes/business", map[string]any{"action": "start", "workOrderId": orderID}, admin...)
	if start.Code != http.StatusOK {
		return result, fmt.Errorf("isolated work order start failed: %d", start.Code)
	}
	statuses := make(chan int, contenders)
	var wg sync.WaitGroup
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			input := map[string]any{"action": "report", "workOrderId": orderID, "operationId": operationID, "goodQuantity": target, "scrapQuantity": 0, "idempotencyKey": fmt.Sprintf("lab-%s-%02d", space[:12], i)}
			out := businessLabRequest(ctx, lab.app, http.MethodPost, "/api/stations/mes/business", input, operator...)
			statuses <- out.Code
		}(i)
	}
	wg.Wait()
	close(statuses)
	result.Site = "mes"
	result.Attempted = contenders
	result.WorkOrderID = orderID
	result.WorkOrderNo = orderNo
	result.Target = target
	for code := range statuses {
		switch code {
		case http.StatusOK:
			result.Succeeded++
		case http.StatusConflict:
			result.Conflicts++
		default:
			if ctx.Err() != nil || code >= 500 {
				result.Unknown++
			} else {
				result.Failed++
			}
		}
	}
	// A client can cancel after a commit. Reconcile under a bounded independent context before cleanup.
	reconcileCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = lab.app.db.QueryRowContext(reconcileCtx, `SELECT (SELECT COUNT(*) FROM mes_production_reports WHERE organization_id=? AND work_order_id=?),target_quantity-completed_quantity-scrapped_quantity,status,completed_quantity,scrapped_quantity,target_quantity,(SELECT COUNT(*) FROM audit_events WHERE organization_id=? AND entity_id=? AND action IN ('mes.start','mes.report')),(SELECT COUNT(*) FROM outbox_events WHERE organization_id=? AND event_type='mes.work-order.changed' AND json_extract(payload,'$.workOrderId')=?) FROM mes_work_orders WHERE organization_id=? AND id=?`, org, orderID, org, orderID, org, orderID, org, orderID).Scan(&result.BusinessRows, &result.Remaining, &result.Status, &result.Completed, &result.Scrapped, &result.Target, &result.AuditRows, &result.ProjectionEvents)
	result.Reconciled = err == nil && result.BusinessRows == 1 && result.Remaining == 0 && result.Status == "completed" && result.Completed == result.Target && result.Scrapped == 0 && result.AuditRows >= 2 && result.ProjectionEvents >= 2
	if err != nil {
		return result, fmt.Errorf("cannot reconcile isolated business results: %w", err)
	}
	if err = ctx.Err(); err != nil {
		return result, err
	}
	result.Valid = result.Reconciled && result.Succeeded == 1 && result.Conflicts == contenders-1 && result.Unknown == 0 && result.Failed == 0
	result.ElapsedMs = float64(time.Since(started).Microseconds()) / 1000
	return result, nil
}

func (a *App) businessLabAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "Use POST")
		return
	}
	if r.PathValue("site") != "mes" {
		fail(w, http.StatusNotFound, "Business lab is unavailable for this workspace")
		return
	}
	id, err := a.identity(r)
	if err != nil {
		fail(w, http.StatusUnauthorized, "Sign in to use the MES business lab")
		return
	}
	grant := id.grant("mes")
	if grant == nil || grant.Scope != "back" || (grant.Role != "admin" && grant.Role != "operator") {
		fail(w, http.StatusForbidden, "MES back-office write access is required")
		return
	}
	var input struct {
		Contenders int `json:"contenders"`
	}
	if body(r, &input) != nil || input.Contenders < 2 || input.Contenders > 32 {
		fail(w, http.StatusBadRequest, "Contenders must be between 2 and 32")
		return
	}
	if a.labManager == nil {
		fail(w, http.StatusServiceUnavailable, "Business lab is not configured")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	result, err := runMESBusinessLab(ctx, a.labManager, input.Contenders)
	if errors.Is(err, errBusinessLabCapacity) {
		fail(w, http.StatusTooManyRequests, "Another MES business lab run is active")
		return
	}
	if err != nil {
		log.Printf("MES business lab failed: %v", err)
		fail(w, http.StatusServiceUnavailable, "MES business lab could not complete; inspect server logs for the run failure")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	ok(w, result)
}
