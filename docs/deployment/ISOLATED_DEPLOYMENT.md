# MES 獨立部署架構

## 範圍

此範本將本 repo 的 MES Go 工作站部署為單一、獨立的 OCI/Linux Compose 專案。它不呼叫、不讀取、不重啟既有 `business-suite` Compose project，不掛載 Docker socket，也不改動既有共享 edge、Web、資料庫、volume 或 DNS。每站以明確 `mes` project、`mes-station` service、`mes-station-data` volume 及 loopback upstream port 區分。

本次只部署此 repo 的 Go 工作站映像；它用自己的 SQLite volume。Vinext/Cloudflare Workers、D1 資料庫與既有展示資料不會自動遷移或共用。MES 根 hostname/DNS/Caddy 設定由維運人員另行審核；此部署器只在明確設定的 loopback port 提供 upstream，預設不建立公開入口。

## 發布流程與邊界

1. CI 或發行者將 repo archive 上傳到主機指定 staging 目錄，並提供完整 Git SHA 與 archive SHA-256。部署器拒絕不符合格式的輸入及校驗失敗的 archive。
2. 部署器在 `/srv/business-suite-mes` 下建立唯一本次 release 目錄，將 archive 解壓至其中，Compose 使用該 release 的 Dockerfile 建置不可變 tag。
3. 以 `mes` Compose project 單獨啟動 `mes-station`；資料 volume 固定為 `mes-mes-station-data`。舊服務映像以 digest/tag 保留；部署前記錄舊 release。
4. 僅以 `http://127.0.0.1:<MES_DEPLOY_PORT>/api/health` 驗證。連續健康檢查成功後才更新 `/srv/business-suite-mes/current` symlink。
5. 建置、啟動或健康檢查失敗時，僅用 MES 專案回復先前映像/設定並重新等待 health。資料 volume 不刪除、不回復舊快照；資料 schema migration 若不可逆，不在本範本支援範圍，必須另備升級與恢復設計。

Compose 專案名固定 `mes`，服務名與 volume 名固定於專案命名空間。可設定 loopback port，預設 18095；部署前須確認未被占用。此 port 不應直接開放公網。前置代理需由獨立、明確核准的變更接到 `127.0.0.1:18095`，不得覆寫共享 Caddy 設定。

## 主機前置條件

- Linux 主機已安裝 Docker Engine/Compose v2、Bash、Python 3、`flock`、`sha256sum`、`tar`、`curl`。
- 部署帳號有權管理本機 Docker，並能寫入 `/srv/business-suite-mes`；建議使用專用 Unix 帳號與最小主機權限。
- 提供經帶外核對的 SSH host key；CI 私鑰只放受保護、手動核准的 GitHub Environment，不能放 repo、archive 或日誌。私鑰/憑證值不得傳給部署腳本參數。
- staging archive 來源只允許受信任 release workflow；確認 GHCR/GitHub 權限與主機網路政策後，才可接入自動上傳。
- 首次部署前人工確認 release root、磁碟空間、Docker Compose project/volume 名稱沒有既有衝突，以及 loopback port 空閒。部署器會拒絕既存目錄衝突，不清理共享資源。

## 操作

部署器需在主機執行，輸入為已上傳的 repo archive：

```bash
sudo install -d -m 0750 -o mes-deploy -g mes-deploy /srv/business-suite-mes/releases
MES_DEPLOY_ROOT=/srv/business-suite-mes \
MES_DEPLOY_PORT=18095 \
bash infra/linux/deploy-mes-release.sh <40-char-git-sha> <64-char-archive-sha256> /srv/business-suite-mes/staging/<sha>.tgz
```

生產自動化應將 SHA 與 checksum 從同一次受保護的 CI artifact 傳入，並在 GitHub Environment 設置 required reviewers。範本未設定 SSH/GitHub secrets、OCI host key、網域、DNS、edge route 或自動觸發器；管理員確認並配置前不會自行發布。

## 驗收與回滾

由維運人員在專用 staging/測試主機執行 `bash infra/linux/test-mes-deployment.sh`。腳本會驗證 Compose config，建置並啟動 MES 專案，確認健康回應及資料持久性，並以獨立探針確認名稱/volume 隔離。它還會在唯一 `/tmp` 部署 root 下確認 symlink、hardlink、FIFO 與路徑穿越 archive 被拒絕，並注入必然失敗的 healthcheck 以驗證舊 image、health endpoint 與 `current` release 還原。完成後只清理它建立的測試容器、volume 與唯一測試 root。禁止在共享/正式主機執行此清理測試。

Archive 抽取先完整檢查成員名稱，只接受普通檔案和目錄，拒絕連結與特殊檔案，再逐檔寫入唯一暫存 release 目錄；驗證完成後才原子移入正式 releases 目錄。Rollback 各步驟與健康檢查均需成功；任何一步失敗會以 exit 70 明確報告 rollback incomplete，要求人工介入，不會把失敗吞掉。

正式發布需額外由主機外部驗證 hostname DNS、有效 TLS、MES 首頁/API、非 MES 路徑拒絕及授權。主機內 loopback health 不代表公開 ingress 成功。回滾由部署器在 release 切換前自動處理；切換後手動回復需選擇先前 SHA 對應的 release，確認 schema 相容後用同一部署器流程操作。
