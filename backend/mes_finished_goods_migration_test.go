package main

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMESFinishedGoodsUpgradePreservesEarlyDisposition(t *testing.T) {
	path := filepath.Join(t.TempDir(), "station.sqlite")
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`DROP TABLE mes_finished_goods_quality_dispositions;
		CREATE TABLE mes_finished_goods_quality_dispositions (
		 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, batch_id TEXT NOT NULL,
		 passed_quantity INTEGER NOT NULL, failed_quantity INTEGER NOT NULL,
		 disposition TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		INSERT INTO mes_finished_goods_quality_dispositions(id,organization_id,batch_id,passed_quantity,failed_quantity,disposition)
		VALUES('old','org_old','batch_old',1,0,'release');`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		db, err = openDB(path)
		if err != nil {
			t.Fatalf("upgrade attempt %d: %v", i, err)
		}
		var check sql.NullString
		var after int64
		var reason, disposition string
		err = db.QueryRow("SELECT quality_check_id,reinspection_after,reason,disposition FROM mes_finished_goods_quality_dispositions WHERE id='old'").Scan(&check, &after, &reason, &disposition)
		if err != nil || check.Valid || after != 0 || reason != "" || disposition != "release" {
			t.Fatalf("historical disposition changed: %v %d %q %q %v", check, after, reason, disposition, err)
		}
		if err = db.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMESFinishedGoodsUpgradeRejectsIncompatibleSchemaWithoutChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "station.sqlite")
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`DROP TABLE mes_finished_goods_quality_dispositions;
		CREATE TABLE mes_finished_goods_quality_dispositions (
		 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, batch_id TEXT NOT NULL,
		 passed_quantity INTEGER NOT NULL, failed_quantity INTEGER NOT NULL,
		 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		INSERT INTO mes_finished_goods_quality_dispositions(id,organization_id,batch_id,passed_quantity,failed_quantity)
		VALUES('old','org_old','batch_old',1,0);`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	if reopened, err := openDB(path); err == nil {
		reopened.Close()
		t.Fatal("incompatible schema accepted")
	}
	check, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer check.Close()
	var count int
	if err = check.QueryRow("SELECT count(*) FROM mes_finished_goods_quality_dispositions WHERE id='old'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("historical row lost: %d %v", count, err)
	}
	if err = check.QueryRow("SELECT count(*) FROM pragma_table_info('mes_finished_goods_quality_dispositions') WHERE name='quality_check_id'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial upgrade persisted: %d %v", count, err)
	}
}