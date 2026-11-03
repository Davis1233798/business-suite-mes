# MES repository CI 範圍

## 架構與程式邊界

MES 專題的 GitHub Actions 應只建置、測試與封裝 MES 自身：Node 測試、TypeScript、MES Go 測試、React 建置與 MES 容器。不得要求其他系統 API，也不得沿用可重啟整套服務的 OCI 部署腳本。推送 main 可發布版本化 MES 容器；正式站自動部署需另有 MES 專屬環境、資料庫、憑證、health 與回滾驗收，尚未具備時不可宣稱已部署。

## 測試

現有單站 Go 路由隔離測試及 MES 新資料庫與備份測試先行，遠端 CI 應在乾淨 checkout 執行；每項檢查結果需顯示於 GitHub Actions。公開 repository 前先檢查完整提交紀錄及機密，不覆蓋其他 repo 的資料或部署。
