# MES 獨立部署架構

## 範圍

此範本將本 repo 的 MES Go 工作站部署為單一、獨立的 OCI/Linux Compose 專案。它不呼叫、不讀取、不重啟既有 `business-suite` Compose project，不掛載 Docker socket，也不改動既有共享 edge、Web、資料庫、volume 或 DNS。正式站固定使用 Compose project `business-suite-mes`、service `mes-station`、volume `business-suite-mes-station-data` 及 loopback port `18095`。測試 root 僅能使用各自唯一的測試 project、volume 與 port。

本次只部署此 repo 的 Go 工作站映像；它用自己的 SQLite volume。Vinext/Cloudflare Workers、D1 資料庫與既有展示資料不會自動遷移或共用。MES 根 hostname/DNS/Caddy 設定由維運人員另行審核；此部署器只在明確設定的 loopback port 提供 upstream，預設不建立公開入口。

## 發布流程與邊界

1. `main` push 的 CI 驗證成功後，將該 commit 的 source archive 與 SHA-256 作為短期 artifact。部署 job 僅在 `MES_DEPLOY_ENABLED=true` 時進入受保護的 `mes-production` GitHub Environment；需在 GitHub 外部設定 required reviewers、專用部署帳號與專屬 SSH secrets。工作流程以預先核對的 known-host key、`StrictHostKeyChecking=yes` 上傳唯一檔名 archive，並提供完整 Git SHA 與 archive SHA-256。部署器拒絕不符合格式的輸入及校驗失敗的 archive。未設定啟用變數或 secrets 時不部署。
2. 部署器在 `/srv/business-suite-mes` 下建立唯一本次 release 目錄，將 archive 解壓至其中。`Dockerfile.station` 的 Node build stage 從 archive 中的 `package-lock.json` 與前端來源安裝鎖定依賴並執行 `npm run web:build`。前端輸入包含 `web/`、`public/`、`app/globals.css` 所引用的 `app/suite.css`、`app/expressive.css`，以及 `vendor/shadcn-tailwind-4.13.0.css`；Docker build context 必須保留這些相對路徑。Go build stage 編譯 backend。此 archive 不依賴本機/CI 的 `web-dist` 或 `node_modules`。
3. 以 `business-suite-mes` Compose project 單獨啟動 `mes-station`；資料 volume 固定為 `business-suite-mes-station-data`。部署器檢查 project 中所有 container，若出現非 MES service 或多個 MES service 即拒絕操作。正式 root 必須由維運預先建立並放置 owner marker；部署器不會自行認領既有目錄。舊服務映像以 digest/tag 保留；部署前記錄舊 release。
4. 僅以 `http://127.0.0.1:<MES_DEPLOY_PORT>/api/health` 驗證。連續健康檢查成功後才更新 `/srv/business-suite-mes/current` symlink。
5. 建置、啟動或健康檢查失敗時，僅用 MES 專案回復先前映像/設定並重新等待 health。資料 volume 不刪除、不回復舊快照；資料 schema migration 若不可逆，不在本範本支援範圍，必須另備升級與恢復設計。

Compose project、volume 與 loopback port 在正式環境不可覆寫；部署前須確認 port 未被占用且 Docker 名稱沒有外站資源衝突。此 port 不應直接開放公網。前置代理需由獨立、明確核准的變更接到 `127.0.0.1:18095`，不得覆寫共享 Caddy 設定。部署 job 不建立 DNS、TLS、Caddy route 或公開 ingress。

## 主機前置條件

- Linux 主機已安裝 Docker Engine/Compose v2、Bash、Python 3、`flock`、`sha256sum`、`tar`、`curl`。
- 維運人員需先建立 `/srv/business-suite-mes`、`releases/`、`staging/`、專用 Unix 部署帳號，以及內容恰為 `business-suite-mes/v1` 的 `.mes-deploy-owner` marker。部署帳號有權管理本機 Docker，並能寫入此 root；不得共用中央站台部署帳號。
- 專用 GitHub Environment `mes-production` 需設 required reviewers。提供專屬 `MES_DEPLOY_TARGET`、`MES_DEPLOY_KEY`、經帶外核對的 `MES_DEPLOY_HOST_KEY`，及 repository variable `MES_DEPLOY_ENABLED=true`。不得重用中央 `OCI_*` secrets。私鑰/憑證值不得傳給部署腳本參數或輸出到日誌。
- staging archive 來源只允許受信任 `main` workflow；確認 GitHub Environment 核准者、主機網路政策與 SSH host key 後，才可設定啟用變數。
- 首次部署前人工確認 release root owner marker、磁碟空間、Docker project/volume 名稱沒有既有衝突，以及 loopback port 空閒。部署器不會清理共享資源或自動建立 owner marker。

## 操作

部署器需在主機執行，輸入為已上傳的 repo archive：

```bash
sudo install -d -m 0750 -o mes-deploy -g mes-deploy /srv/business-suite-mes/releases /srv/business-suite-mes/staging
printf 'business-suite-mes/v1\n' | sudo tee /srv/business-suite-mes/.mes-deploy-owner
MES_DEPLOY_ROOT=/srv/business-suite-mes \
MES_DEPLOY_PROJECT=business-suite-mes \
MES_DEPLOY_DATA_VOLUME=business-suite-mes-station-data \
MES_DEPLOY_PORT=18095 \
bash infra/linux/deploy-mes-release.sh <40-char-git-sha> <64-char-archive-sha256> /srv/business-suite-mes/staging/<sha>.tgz
```

工作流程中的部署 job 只會在上述 GitHub Environment 和 `MES_DEPLOY_ENABLED=true` 都設定後執行。此 repo 不包含正式主機、secrets、host key 或環境核准者配置；目前不能宣稱自動部署已啟用。

## 驗收與回滾

由維運人員在專用 staging/測試主機執行 `bash infra/linux/test-mes-deployment.sh`。腳本會用 `git archive` 建立不含 `web-dist` 的真實 source archive，檢查 lockfile、前端 source 及其共用 CSS 相依檔均在 archive，再以該 archive 驗證 Compose build、啟動與 health；確認資料持久性，並以獨立探針確認名稱/volume 隔離。它還會在唯一 `/tmp` 部署 root 下確認 symlink、hardlink、FIFO 與路徑穿越 archive 被拒絕，並注入必然失敗的 healthcheck 以驗證舊 image、health endpoint 與 `current` release 還原。完成後只清理它建立的測試容器、volume 與唯一測試 root。禁止在共享/正式主機執行此清理測試。

Archive 抽取先完整檢查成員名稱，只接受普通檔案和目錄，拒絕連結與特殊檔案，再逐檔寫入唯一暫存 release 目錄；驗證完成後才原子移入正式 releases 目錄。Rollback 各步驟與健康檢查均需成功；任何一步失敗會以 exit 70 明確報告 rollback incomplete，要求人工介入，不會把失敗吞掉。

正式發布需額外由主機外部驗證 hostname DNS、有效 TLS、MES 首頁/API、非 MES 路徑拒絕及授權。主機內 loopback health 不代表公開 ingress 成功。回滾由部署器在 release 切換前自動處理；切換後手動回復需選擇先前 SHA 對應的 release，確認 schema 相容後用同一部署器流程操作。
