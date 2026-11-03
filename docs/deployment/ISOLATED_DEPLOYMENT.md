# MES 獨立部署架構

## 範圍

此範本將本 repo 的 MES Go 工作站部署到既有 OCI Linux 主機上的獨立 rootless Compose 專案，可與 portfolio Web stack 共存。MES 使用獨立 `mes-runtime` 帳號、rootless Docker daemon、Compose project `business-suite-mes`、service `mes-station`、volume `business-suite-mes-station-data`、release root `/srv/business-suite-mes` 及 loopback port `18095`。MES 帳號必須無法讀取或穿越 `/srv/business-suite`，也不得讀取 rootful Docker socket；主機稽核會實際檢查這些拒絕存取條件。測試 root 僅能使用各自唯一的測試 project、volume 與 port。

生產 Docker daemon 必須以 `mes-runtime` 帳號使用 rootless mode。GitHub SSH 帳號 `mes-deploy` 不得加入 `docker` 群組、不得讀取任何 Docker socket、不得取得互動 shell。root-owned SSH `ForceCommand` gateway 僅接受 `status` 和 `deploy <git-sha> <archive-sha256>`；收到 archive 後，gateway 將部署工作交給 `mes-runtime` 執行。這樣限制 CI key 的登入命令及其主機權限。主機稽核及 gateway status/deploy 都會拒絕 MES 帳號能讀取 portfolio 根目錄、rootful Docker socket，或存取其他帳號部署資料的情況。此設定提供帳號、daemon、服務及資料分離，但不宣稱能隔離共享 Linux kernel；rootless Docker、Compose project 名稱或容器 label 都不是完整 host isolation。

本次只部署此 repo 的 Go 工作站映像；它用自己的 SQLite volume。Vinext/Cloudflare Workers、D1 資料庫與既有展示資料不會自動遷移或共用。MES 根 hostname/DNS/Caddy 設定由維運人員另行審核；此部署器只在明確設定的 loopback port 提供 upstream，預設不建立公開入口。

## 跨主機路由限制

Profolio PR17 的 MES Caddy route 連到 rootful Docker network `business-suite-mes_default`。本方案使用同一 OCI host 上獨立的 rootless daemon；兩個 daemon 的 network namespace 不相通，Caddy 不能用 Docker service name `mes-station` 到達它。`127.0.0.1:18095` 是 OCI host loopback upstream；需在 Profolio IaC 另行配置 Caddy 到 host loopback 的受控連線及來源限制，再驗證端到端健康與授權。

本 PR 部署至既有 OCI 主機，但不完成公開 hostname cutover；不可執行依賴 rootful Docker network `business-suite-mes_default` 的 Profolio `cutover-mes-public-route.sh` 來宣稱路由已切換。rootless daemon 的 network namespace 與 rootful daemon 分開，Caddy 不能透過該 Docker service name 到達 MES。若要公開化，需先在 Profolio repo 設計受控的主機內或私網 upstream，限制來源並完成端到端 health/授權驗收。不得為了接通而把 MES 加回中央 rootful Docker daemon、共用 Docker group 或共用資料 volume。

## 發布流程與邊界

1. `main` push 的 CI 驗證成功後，將該 commit 的 source archive 與 SHA-256 作為短期 artifact。部署 job 僅在 `MES_DEPLOY_ENABLED=true` 時進入 `mes-production` GitHub Environment；需在 GitHub 外部配置專用部署帳號與專屬 SSH secrets。工作流程以預先核對的 known-host key、`StrictHostKeyChecking=yes` 將 archive 以 SSH stdin 傳給固定 forced command；不使用 SCP/SFTP、不上傳或遠端執行 CI 提供的 shell script。請求只包含完整 Git SHA 與 archive SHA-256。部署器拒絕不符合格式的輸入及校驗失敗的 archive。未設定啟用變數或 secrets 時不部署。
2. 部署器在 `/srv/business-suite-mes` 下建立唯一本次 release 目錄，將 archive 解壓至其中。`Dockerfile.station` 的 Node build stage 從 archive 中的 `package-lock.json` 與前端來源安裝鎖定依賴並執行 `npm run web:build`。前端輸入包含 `web/`、`public/`、`app/globals.css` 所引用的 `app/suite.css`、`app/expressive.css`，以及 `vendor/shadcn-tailwind-4.13.0.css`；Docker build context 必須保留這些相對路徑。Go build stage 編譯 backend。此 archive 不依賴本機/CI 的 `web-dist` 或 `node_modules`。
3. 以 `business-suite-mes` Compose project 單獨啟動 `mes-station`；資料 volume 固定為 `business-suite-mes-station-data`。部署器檢查 project 中所有 container，若出現非 MES service 或多個 MES service 即拒絕操作。正式 root 必須由維運預先建立並放置 owner marker；部署器不會自行認領既有目錄。舊服務映像以 digest/tag 保留；部署前記錄舊 release。
4. 僅以 `http://127.0.0.1:<MES_DEPLOY_PORT>/api/health` 驗證。連續健康檢查成功後才更新 `/srv/business-suite-mes/current` symlink。
5. 建置、啟動或健康檢查失敗時，僅用 MES 專案回復先前映像/設定並重新等待 health。資料 volume 不刪除、不回復舊快照；資料 schema migration 若不可逆，不在本範本支援範圍，必須另備升級與恢復設計。

Compose project、volume 與 loopback port 在正式環境不可覆寫；部署前須確認 port 未被占用且 Docker 名稱沒有外站資源衝突。此 port 不應直接開放公網。中央 Caddy 容器目前無法透過 rootful Docker network 直接連入 rootless network；需透過 host gateway 到 `127.0.0.1:18095` 並限制可達來源。這項 Caddy upstream/IaC 變更不在本部署器範圍內。部署 job 不建立 DNS、TLS、Caddy route 或公開 ingress。

## 主機前置條件及權限

- 既有 OCI Linux 主機已安裝 rootless Docker Engine/Compose v2、Bash、Python 3、`flock`、`sha256sum`、`tar`、`curl`。
- 維運人員需建立互相隔離的 `mes-deploy` 與 `mes-runtime` 帳號。`mes-runtime` 擁有自己的 rootless Docker daemon、MES project 和資料；`mes-deploy` 沒有 Docker 權限、沒有 runtime home/data 存取權，也不能互動登入。不要將任何帳號加入 rootful `docker` 群組。
- 將 `infra/linux/mes-deploy-gateway.py` 安裝為 root-owned、不可由兩個 service account 修改的 `/usr/local/sbin/mes-deploy-gateway`；`infra/linux/mes-deploy.sudoers` 僅允許 `mes-deploy` 以 root 執行這支固定檔案。將 `infra/linux/sshd-mes-deploy.conf` 的 `Match User mes-deploy` 設定放在 sshd 有效設定的最後，並停用 TTY、TCP/stream-local/agent forwarding、X11、密碼和 user rc。以 `sshd -T -C user=mes-deploy,host=<host>,addr=<runner-ip>` 核對 effective policy。Gateway 只允許 `status`、`deploy <sha> <digest>`，且只以 `runuser -u mes-runtime` 啟動受控發布程序；不得接受任意命令、路徑、Compose project、volume 或 port。
- 維運人員預先建立 `/srv/business-suite-mes`、`releases/`、`staging/` 及內容恰為 `business-suite-mes/v1` 的 `.mes-deploy-owner` marker。`/srv/business-suite-mes` 與 `staging/` 由 `mes-runtime` 私有擁有；runtime 負責 staging archive 的存取與清理。Root gateway 的短期 inbox 位於 `/run/mes-deploy-inbox`，權限為 `root:mes-runtime`、`0710`，只提供 runtime 目錄穿越與讀取 root 建立之交付檔案的權限，不允許 runtime 改動 inbox；gateway 先在這個 root-controlled 路徑寫完並驗證上傳，再以 runtime 身分將檔案複製入 staging。部署 helper 從已校驗的 main archive 解出後，以 `mes-runtime` 身分執行。資料 volume 由 `mes-runtime` 的 rootless daemon 管理；不得指向共用 Docker socket 或任何共享資料目錄。
- 專用 GitHub Environment `mes-production` 提供專屬 `MES_DEPLOY_TARGET`、`MES_DEPLOY_KEY`、經帶外核對的 `MES_DEPLOY_HOST_KEY`，及 repository variable `MES_DEPLOY_ENABLED=true`。不得重用中央 `OCI_*` secrets。私鑰/憑證值不得傳給部署腳本參數或輸出到日誌。
- staging archive 來源只允許受信任 `main` workflow；確認 GitHub Environment 核准者、主機網路政策與 SSH host key 後，才可設定啟用變數。
- 首次部署前人工確認 release root owner marker、磁碟空間、Docker project/volume 名稱沒有既有衝突，以及 loopback port 空閒。部署器不會清理共享資源或自動建立 owner marker。

## 操作與遠端安全驗收

由維運人員將 root-owned gateway、sudoers 規則和 SSH 限制檔安裝到既有 OCI host；先以 `visudo -cf /etc/sudoers.d/mes-deploy` 與 `sshd -t` 驗證設定，再 reload sshd。`mes-runtime` 需啟用 user linger 並啟動自己的 rootless Docker daemon。部署資料夾與 marker 的參考建立方式如下，僅建立 MES 專屬路徑，不更動 portfolio 檔案或服務：

```bash
sudo install -d -m 0750 -o mes-runtime -g mes-runtime /srv/business-suite-mes /srv/business-suite-mes/releases /srv/business-suite-mes/staging
sudo install -d -m 0710 -o root -g mes-runtime /run/mes-deploy-inbox
printf 'business-suite-mes/v1\n' | sudo tee /srv/business-suite-mes/.mes-deploy-owner
sudo chmod 0444 /srv/business-suite-mes/.mes-deploy-owner
sudo -u mes-runtime env XDG_RUNTIME_DIR=/run/user/"$(id -u mes-runtime)" DOCKER_HOST=unix:///run/user/"$(id -u mes-runtime)"/docker.sock docker info --format '{{json .SecurityOptions}}'
```

Gateway 檔案請安裝為 `root:root` mode `0750`，sudoers 檔案 `root:root` mode `0440`。Forced command 會用 sudo 把原始 SSH 命令作單一參數傳給 gateway；不允許 scp/SFTP 或遠端 shell。Deploy public key 與 `mes-deploy` 帳號設定只由維運人員透過 host provisioning 完成。可用下列命令部署並檢查程式檔案；實際 host 變更需在專用主機維護流程內執行：

```bash
sudo install -o root -g root -m 0750 infra/linux/mes-deploy-gateway.py /usr/local/sbin/mes-deploy-gateway
sudo install -o root -g root -m 0440 infra/linux/mes-deploy.sudoers /etc/sudoers.d/mes-deploy
sudo visudo -cf /etc/sudoers.d/mes-deploy
sudo sshd -t
```

在加入 GitHub Environment secrets 前，以 root 在目標 OCI 主機執行 `sudo bash infra/linux/test-mes-host-isolation.sh`。這是唯讀主機稽核，確認 deploy/runtime 帳號邊界、rootless daemon、SSH forced command、固定路徑，以及 portfolio `/srv/business-suite`（若存在）對 MES 帳號的讀取和穿越拒絕。若探針不能明確確認拒絕，稽核會失敗；不得在未通過稽核時啟用部署。

保留現有 `infra/linux/test-mes-deployment.sh` 作隔離 Compose 專案的建立、健康、資料持久與 rollback 回歸測試。該腳本會建立並刪除暫存 Docker 資源，只能在 disposable runner 或專用測試主機執行，不能在正式主機執行。

工作流程中的部署 job 保留 `main` push 自動觸發語意，只會在上述 GitHub Environment secrets 和 `MES_DEPLOY_ENABLED=true` 都設定後執行。此 repo 不包含正式主機、secrets 或 host key；目前不能宣稱自動部署已啟用。

## 驗收與回滾

由維運人員在 disposable runner 或專用測試主機執行 `bash infra/linux/test-mes-deployment.sh`。此腳本會建立並刪除測試 Docker 資源，不得在正式 OCI 主機執行。腳本會用 `git archive` 建立不含 `web-dist` 的真實 source archive，檢查 lockfile、前端 source 及其共用 CSS 相依檔均在 archive，再以該 archive 驗證 Compose build、啟動與 health；確認資料持久性，並以獨立探針確認名稱/volume 隔離。它還會在唯一 `/tmp` 部署 root 下確認 symlink、hardlink、FIFO 與路徑穿越 archive 被拒絕，並注入必然失敗的 healthcheck 以驗證舊 image、health endpoint 與 `current` release 還原。完成後只清理它建立的測試容器、volume 與唯一測試 root。禁止在共享/正式主機執行此清理測試。

Archive 抽取先完整檢查成員名稱，只接受普通檔案和目錄，拒絕連結與特殊檔案，再逐檔寫入唯一暫存 release 目錄；驗證完成後才原子移入正式 releases 目錄。Rollback 各步驟與健康檢查均需成功；任何一步失敗會以 exit 70 明確報告 rollback incomplete，要求人工介入，不會把失敗吞掉。

正式發布需額外由主機外部驗證 hostname DNS、有效 TLS、MES 首頁/API、非 MES 路徑拒絕及授權。主機內 loopback health 不代表公開 ingress 成功。回滾由部署器在 release 切換前自動處理；切換後手動回復需選擇先前 SHA 對應的 release，確認 schema 相容後用同一部署器流程操作。
