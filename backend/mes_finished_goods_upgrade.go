package main

import (
	"database/sql"
	"fmt"
)

func upgradeMESFinishedGoodsColumns(tx *sql.Tx) error {
	rows, err := tx.Query("PRAGMA table_info(mes_finished_goods_quality_dispositions)")
	if err != nil {
		return fmt.Errorf("cannot inspect finished goods schema: %w", err)
	}
	columns := map[string]bool{}
	for rows.Next() {
		var index, notNull, primary int
		var name, typ string
		var defaultValue any
		if err = rows.Scan(&index, &name, &typ, &notNull, &defaultValue, &primary); err != nil {
			break
		}
		columns[name] = true
	}
	if err == nil {
		err = rows.Err()
	}
	closeErr := rows.Close()
	if err != nil || closeErr != nil {
		return fmt.Errorf("cannot inspect finished goods schema")
	}
	for _, required := range []string{"id", "organization_id", "batch_id", "passed_quantity", "failed_quantity", "disposition", "created_at"} {
		if !columns[required] {
			return fmt.Errorf("incompatible finished goods schema: missing %s", required)
		}
	}
	for _, column := range []struct{ name, definition string }{
		{"quality_check_id", "TEXT"}, {"reinspection_after", "INTEGER NOT NULL DEFAULT 0"}, {"reason", "TEXT NOT NULL DEFAULT ''"},
	} {
		if !columns[column.name] {
			if _, err = tx.Exec("ALTER TABLE mes_finished_goods_quality_dispositions ADD COLUMN " + column.name + " " + column.definition); err != nil {
				return fmt.Errorf("cannot upgrade finished goods schema: %w", err)
			}
		}
	}
	return nil
}