# MES 獨立部署架構

## 範圍

此範本將本 repo 的 MES Go 工作站部署到既有 OCI Linux 主機上的獨立 rootless Compose 專案，可與 portfolio Web stack 共存。MES 使用獨立 `mes-runtime` 帳號、rootless Docker daemon、Compose project `business-suite-mes`、service `mes-station`、volume `business-suite-mes-station-data`、release root `/srv/business-suite-mes` 及 loopback port `18095`。MES 帳號必須無法讀取或穿越 `/srv/business-suite`，也不得讀取 rootful Docker socket；主機稽核會實際檢查這些拒絕存取條件。測試 root 僅能使用各自唯一的測試 project、volume 與 port。

生產 Docker daemon 必須以 `mes-runtime` 帳號使用 rootless mode。GitHub SSH 帳號 `mes-deploy` 不得加入 `docker` 群組、不得讀取任何 Docker socket、不得取得互動 shell。root-owned SSH `ForceCommand` gateway 僅接受 `status` 和 `deploy <git-sha> <archive-sha256>`；收到 archive 後，gateway 將部署工作交給 `mes-runtime` 執行。這樣限制 CI key 的登入命令及其主機權限。主機稽核及 gateway status/deploy 都會拒絕 MES 帳號能讀取 portfolio 根目錄、rootful Docker socket，或存取其他帳號部署資料的情況。此設定提供帳號、daemon、服務及資料分離，但不宣稱能隔離共享 Linux kernel；rootless Docker、Compose project 名稱或容器 label 都不是完整 host isolation。

本次只部署此 repo 的 Go 工作站映像；它用自己的 SQLite volume。Vinext/Cloudflare Workers、D1 資料庫與既有展示資料不會自動遷移或共用。MES 根 hostname/DNS/Caddy 設定由維運人員另行審核；此部署器只在明確設定的 loopback port 提供 upstream，預設不建立公開入口。

## 跨 daemon 路由限制

Profolio PR17 的 MES Caddy route 連到 rootful Docker network `business-suite-mes_default`。本方案使用同一 OCI host 上獨立的 rootless daemon；兩個 daemon 的 network namespace 不相通，Caddy 不能用 Docker service name `mes-station` 到達它。`127.0.0.1:18095` 是 OCI host loopback upstream；需在 Profolio IaC 另行配置 Caddy 到 host loopback 的受控連線及來源限制，再驗證端到端健康與授權。

部署目標是既有 OCI 主機；本 PR 不執行部署，也不完成公開 hostname cutover。不可執行依賴 rootful Docker network `business-suite-mes_default` 的 Profolio `cutover-mes-public-route.sh` 來宣稱路由已切換。rootless daemon 的 network namespace 與 rootful daemon 分開，Caddy 不能透過該 Docker service name 到達 MES。若要公開化，需先在 Profolio repo 實作受控 host proxy／Unix socket upstream，限制來源並完成端到端 health/授權驗收。不得為了接通而把 MES 加回中央 rootful Docker daemon、共用 Docker group 或共用資料 volume。

## 發布流程與邊界

強制命令 gateway 先將 SSH stdin archive 寫入 root 控制的 /run/mes-deploy-inbox（root:mes-runtime、0710，由 tmpfiles 建立），校驗後才交由 runtime 移入自己的 staging。不得在 runtime 可寫的父目錄以 root 建立或清除暫存檔。失敗時保留部署器的拒絕原因；CI 會在刪除一次性診斷檔前輸出有界的 preflight 日誌，禁止以任意失敗取代指定的 port ownership 拒絕條件。

1. `main` push 的 CI 驗證成功後，將該 commit 的 source archive 與 SHA-256 作為短期 artifact。部署 job 僅在 `MES_DEPLOY_ENABLED=true` 時進入 `mes-production` GitHub Environment；需在 GitHub 外部配置專用部署帳號與專屬 SSH secrets。工作流程以預先核對的 known-host key、`StrictHostKeyChecking=yes` 將 archive 以 SSH stdin 傳給固定 forced command；不使用 SCP/SFTP、不上傳或遠端執行 CI 提供的 shell script。請求只包含完整 Git SHA 與 archive SHA-256。部署器拒絕不符合格式的輸入及校驗失敗的 archive。未設定啟用變數或 secrets 時不部署。
2. 部署器在 `/srv/business-suite-mes` 下建立唯一本次 release 目錄，將 archive 解壓至其中。`Dockerfile.station` 的 Node build stage 從 archive 中的 `package-lock.json` 與前端來源安裝鎖定依賴並執行 `npm run web:build`。前端輸入包含 `web/`、`public/`、`app/globals.css` 所引用的 `app/suite.css`、`app/expressive.css`，以及 `vendor/shadcn-tailwind-4.13.0.css`；Docker build context 必須保留這些相對路徑。Go build stage 編譯 backend。此 archive 不依賴本機/CI 的 `web-dist` 或 `node_modules`。
3. 以 `business-suite-mes` Compose project 單獨啟動 `mes-station`；資料 volume 固定為 `business-suite-mes-station-data`。部署器檢查 project 中所有 container，若出現非 MES service 或多個 MES service 即拒絕操作。Provisioner 建立正式 root `/srv/business-suite-mes`，並放置 root-owned、mode `0444` 的 `.mes-deploy-owner` marker；marker 內容必須恰為 `business-suite-mes/v1`。部署器會驗證此既有 marker，不會自行認領或改寫目錄。舊服務映像以 digest/tag 保留；部署前記錄舊 release。
4. 僅以 `http://127.0.0.1:<MES_DEPLOY_PORT>/api/health` 驗證。連續健康檢查成功後才更新 `/srv/business-suite-mes/current` symlink。
5. 建置、啟動或健康檢查失敗時，僅用 MES 專案回復先前映像/設定並重新等待 health。資料 volume 不刪除、不回復舊快照；資料 schema migration 若不可逆，不在本範本支援範圍，必須另備升級與恢復設計。

Compose project、volume 與 loopback port 在正式環境不可覆寫；部署前須確認 port 未被占用且 Docker 名稱沒有外站資源衝突。此 port 不應直接開放公網。中央 Caddy 容器目前無法透過 rootful Docker network 直接連入 rootless network；Profolio IaC 須另行實作受控 host proxy／Unix socket upstream 並限制可達來源。這項 Caddy upstream/IaC 變更不在本部署器範圍內。部署 job 不建立 DNS、TLS、Caddy route 或公開 ingress。

## 主機前置條件及權限

- OCI 主機須為 Ubuntu 24.04 ARM64，使用已運作的 rootful Docker Engine 29.x 及 Compose v2、systemd/cgroup v2，並啟用 AppArmor user-namespace 限制。以 `bash infra/linux/provision-mes-rootless-host.sh --check` 唯讀檢查前置條件，再依維運核准執行 `--apply`。Provisioner 分別檢查 `/var/lib` rootless Docker data 與 `/srv` MES releases 所在檔案系統各有至少 8 GiB 可用空間；它只安裝 Ubuntu `acl`, `apparmor`, `dbus-user-session`, `rootlesskit`, `slirp4netns`, `uidmap` 套件，不替換或重啟既有 Docker daemon。
- Provisioner 建立互相隔離的 `mes-deploy` 與 `mes-runtime` 帳號、私有 home、rootless Docker daemon、固定 gateway/sudoers/SSH policy 與 MES 專屬目錄。它只在 `/srv/business-suite` 根目錄加上兩個 UID 的明確 deny ACL，不遞迴改寫 portfolio tree。不要將任何帳號加入 rootful `docker` 群組。
- Dedicated GitHub Environment `mes-production` 可在主機建立並通過唯讀稽核後，另行管理專屬 `MES_DEPLOY_TARGET`、`MES_DEPLOY_KEY`、經帶外核對的 `MES_DEPLOY_HOST_KEY`，及 repository variable `MES_DEPLOY_ENABLED=true`。Provisioner 不配置 SSH key、不設定 secrets/變數。不得重用中央 `OCI_*` secrets；私鑰/憑證值不得傳給部署腳本參數或輸出到日誌。
- staging archive 來源只允許受信任 `main` workflow；確認 GitHub Environment 核准者、主機網路政策與 SSH host key 後，才可設定啟用變數。
- 首次部署前人工確認 rootless runtime、rootful Docker sentinel/資料、磁碟空間、Docker project/volume 名稱沒有既有衝突，以及 loopback port 空閒。部署器不會清理共享資源或接管既有 owner marker。

## 操作與遠端安全驗收

在乾淨 checkout 的 repo 根目錄，以 root 執行唯讀預檢及明確套用命令。Provisioner 對未知帳號、路徑或 marker 會拒絕接管；它不會建立 SSH key，也不會啟用 GitHub deployment。完整流程、目前主機假設與安全邊界見 [`MES_OCI_PROVISIONING.md`](MES_OCI_PROVISIONING.md)。

```bash
sudo bash infra/linux/provision-mes-rootless-host.sh --check
sudo bash infra/linux/provision-mes-rootless-host.sh --apply
sudo bash infra/linux/provision-mes-rootless-host.sh --apply
sudo bash infra/linux/provision-mes-rootless-host.sh --check
sudo bash infra/linux/test-mes-host-isolation.sh
```

若套用中途失敗，工具保留已建立的 root marker、ACL 備份與其他狀態，不執行廣泛清理或自動回復。部分套用狀態不會被當成可重新套用的乾淨主機；先由維運人員比對 marker/ACL/SSH 備份及實際服務，再人工修復。不得直接刪除 marker 來強制重跑。

在加入 GitHub Environment secrets 前，以 root 在目標 OCI 主機執行 `sudo bash infra/linux/test-mes-host-isolation.sh`。這是唯讀主機稽核，確認 deploy/runtime 帳號邊界、rootless daemon、SSH forced command、固定路徑，以及 portfolio `/srv/business-suite`（若存在）對 MES 帳號的讀取和穿越拒絕。若探針不能明確確認拒絕，稽核會失敗；不得在未通過稽核時啟用部署。

保留現有 `infra/linux/test-mes-deployment.sh` 作隔離 Compose 專案的建立、健康、資料持久與 rollback 回歸測試。該腳本會建立並刪除暫存 Docker 資源，只能在 disposable runner 或專用測試主機執行，不能在正式主機執行。

工作流程中的部署 job 保留 `main` push 自動觸發語意，只會在上述 GitHub Environment secrets 和 `MES_DEPLOY_ENABLED=true` 都設定後執行。此 repo 不包含正式主機、secrets 或 host key；目前不能宣稱自動部署已啟用。

## 驗收與回滾

由維運人員在 disposable runner 或專用測試主機執行 `bash infra/linux/test-mes-deployment.sh`。此腳本會建立並刪除測試 Docker 資源，不得在正式 OCI 主機執行。腳本會用 `git archive` 建立不含 `web-dist` 的真實 source archive，檢查 lockfile、前端 source 及其共用 CSS 相依檔均在 archive，再以該 archive 驗證 Compose build、啟動與 health；確認資料持久性，並以獨立探針確認名稱/volume 隔離。它還會在唯一 `/tmp` 部署 root 下確認 symlink、hardlink、FIFO 與路徑穿越 archive 被拒絕，並注入必然失敗的 healthcheck 以驗證舊 image、health endpoint 與 `current` release 還原。完成後只清理它建立的測試容器、volume 與唯一測試 root。禁止在共享/正式主機執行此清理測試。

Archive 抽取先完整檢查成員名稱，只接受普通檔案和目錄，拒絕連結與特殊檔案，再逐檔寫入唯一暫存 release 目錄；驗證完成後才原子移入正式 releases 目錄。Rollback 各步驟與健康檢查均需成功；任何一步失敗會以 exit 70 明確報告 rollback incomplete，要求人工介入，不會把失敗吞掉。

正式發布需額外由主機外部驗證 hostname DNS、有效 TLS、MES 首頁/API、非 MES 路徑拒絕及授權。主機內 loopback health 不代表公開 ingress 成功。回滾由部署器在 release 切換前自動處理；切換後手動回復需選擇先前 SHA 對應的 release，確認 schema 相容後用同一部署器流程操作。
