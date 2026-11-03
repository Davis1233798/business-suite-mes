# MES repository CI 範圍

## 架構與程式邊界

MES 專題的 GitHub Actions 只建置、測試與封裝 MES 自身：Node 測試、TypeScript、MES Go 測試、React 建置與 MES 容器。不得要求其他系統 API，也不得沿用可重啟整套服務的 OCI 部署腳本。`main` push 保留 MES image 發布及受保護環境部署流程；部署需 `MES_DEPLOY_ENABLED=true` 且專用 Environment secrets 可用。部署 key 只呼叫固定 forced-command gateway，沒有 shell 或 Docker group 權限；gateway 要求專用 MES host 與 `mes-runtime` rootless Docker daemon，拒絕 rootful socket。這不代表 `docker` group 是隔離機制，也不把同一共享主機的 Docker project 當作 host boundary。

## 測試

現有單站 Go 路由隔離測試及 MES 新資料庫與備份測試先行，遠端 CI 應在乾淨 checkout 執行；每項檢查結果需顯示於 GitHub Actions。公開 repository 前先檢查完整提交紀錄及機密，不覆蓋其他 repo 的資料或部署。
