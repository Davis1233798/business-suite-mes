# Linux 分站交付包

解壓後，以專用非 root 使用者在交付目錄啟動：

```sh
mkdir -p /var/lib/business-suite
SUITE_WEB="$PWD/web-dist" SUITE_DB=/var/lib/business-suite/stations.sqlite SUITE_ADDR=127.0.0.1:8095 ./station-server
```

此二進位與 `web-dist` 必須來自同一個 GitHub Actions artifact；`COMMIT` 記錄來源版本。以受控代理提供 HTTPS，設定主站建置變數 `NEXT_PUBLIC_STATION_URL` 為實際分站 URL。既有資料庫必須先備份，不要用 CI artifact 覆寫資料。

此版本支援 MES 登入／授權、查詢、列印，以及工單開工和生產報工交易。BOM 編輯、物料收退、品檢、停機等其他寫入流程仍未從展示站移植。併發工作台另以伺服器建立的一次性 SQLite 資料庫執行真實報工 API，結果核對後刪除；它不修改登入者的工作區資料，也不代表多節點或正式環境容量。測試帳號與自動建立展示企業僅供示範，不能作為正式身分系統。
