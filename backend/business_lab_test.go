package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestBusinessLabEndpointRunsIsolatedRealReports(t *testing.T) {
	a := appForTest(t)
	a.labManager = newBusinessLabManager(t.TempDir(), 1)
	space := token()
	operator := loginSite(t, a, "office@suite.test", space, "mes")
	front := loginSite(t, a, "front@suite.test", space, "mes")
	readonly := loginSite(t, a, "viewer@suite.test", space, "mes")
	var organizations, reports int
	if err := a.db.QueryRow("SELECT count(*) FROM mes_work_orders WHERE organization_id=?", "org_test_"+space).Scan(&organizations); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow("SELECT count(*) FROM mes_production_reports WHERE organization_id=?", "org_test_"+space).Scan(&reports); err != nil {
		t.Fatal(err)
	}
	path := "/api/stations/mes/business-lab"
	if w := request(a, http.MethodPost, path, map[string]any{"contenders": 8}); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", w.Code)
	}
	if w := request(a, http.MethodPost, path, map[string]any{"contenders": 8}, front...); w.Code != http.StatusForbidden {
		t.Fatalf("front: %d", w.Code)
	}
	if w := request(a, http.MethodPost, path, map[string]any{"contenders": 8}, readonly...); w.Code != http.StatusForbidden {
		t.Fatalf("readonly: %d", w.Code)
	}
	if w := request(a, http.MethodPost, path, map[string]any{"contenders": 1}, operator...); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid contender count: %d", w.Code)
	}
	occupied, err := a.labManager.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if w := request(a, http.MethodPost, path, map[string]any{"contenders": 8}, operator...); w.Code != http.StatusTooManyRequests {
		t.Fatalf("busy manager: %d", w.Code)
	}
	if err = occupied.close(); err != nil {
		t.Fatal(err)
	}
	w := request(a, http.MethodPost, path, map[string]any{"contenders": 8}, operator...)
	if w.Code != http.StatusOK {
		t.Fatalf("lab: %d %s", w.Code, w.Body.String())
	}
	var result struct {
		Data businessLabResult `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Data.Site != "mes" || result.Data.Attempted != 8 || result.Data.Succeeded != 1 || result.Data.Conflicts != 7 || !result.Data.Reconciled || !result.Data.Valid || result.Data.BusinessRows != 1 || result.Data.AuditRows < 2 || result.Data.ProjectionEvents < 2 || result.Data.Remaining != 0 {
		t.Fatalf("unreconciled business run: %+v", result.Data)
	}
	var afterOrganizations, afterReports int
	if err := a.db.QueryRow("SELECT count(*) FROM mes_work_orders WHERE organization_id=?", "org_test_"+space).Scan(&afterOrganizations); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow("SELECT count(*) FROM mes_production_reports WHERE organization_id=?", "org_test_"+space).Scan(&afterReports); err != nil {
		t.Fatal(err)
	}
	if afterOrganizations != organizations || afterReports != reports {
		t.Fatalf("lab modified shared org: workorders=%d/%d reports=%d/%d", organizations, afterOrganizations, reports, afterReports)
	}
}

func TestBusinessLabManagerCleansDatabaseAndReleasesCapacity(t *testing.T) {
	root := t.TempDir()
	manager := newBusinessLabManager(root, 1)
	lab, err := manager.acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	path := lab.directory
	if filepath.Dir(path) != root {
		t.Fatalf("lab escaped configured root: %s", path)
	}
	if _, err = manager.acquire(t.Context()); err == nil {
		t.Fatal("accepted second concurrent run")
	}
	if err = lab.close(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("temporary database remains: %v", err)
	}
	if lab, err = manager.acquire(t.Context()); err != nil {
		t.Fatalf("slot not released: %v", err)
	}
	if err = lab.close(); err != nil {
		t.Fatal(err)
	}
}

func TestBusinessLabCleanupNeverRemovesAnotherManagerRun(t *testing.T) {
	root := t.TempDir()
	firstManager := newBusinessLabManager(root, 1)
	secondManager := newBusinessLabManager(root, 1) // models a second server process sharing the private root
	first, err := firstManager.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := secondManager.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	secondPath := second.directory
	if err = first.close(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(secondPath); err != nil {
		t.Fatalf("closing one run removed another active run: %v", err)
	}
	if err = second.close(); err != nil {
		t.Fatal(err)
	}
}

func TestBusinessLabRouteRejectsOtherStation(t *testing.T) {
	a := appForTest(t)
	if w := request(a, http.MethodPost, "/api/stations/erp/business-lab", map[string]any{"contenders": 8}); w.Code != http.StatusNotFound {
		t.Fatalf("other station route: %d", w.Code)
	}
	if w := request(a, http.MethodPost, "/api/stations/erp/business", map[string]any{"action": "report"}); w.Code != http.StatusNotFound {
		t.Fatalf("other station business route: %d", w.Code)
	}
}

func TestCanceledBusinessLabRunDoesNotLeakDirectoryOrSlot(t *testing.T) {
	root := t.TempDir()
	manager := newBusinessLabManager(root, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runMESBusinessLab(ctx, manager, 8); err == nil {
		t.Fatal("canceled lab run was accepted")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("canceled run left artifacts: %v", entries)
	}
	probe, err := manager.acquire(context.Background())
	if err != nil {
		t.Fatalf("manager slot leaked: %v", err)
	}
	if err = probe.close(); err != nil {
		t.Fatal(err)
	}
}
