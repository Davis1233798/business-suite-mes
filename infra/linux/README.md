# 既有 Linux 主機部署

## MES 單站隔離部署範本

本 repo 新增的 [MES 獨立部署架構](../../docs/deployment/ISOLATED_DEPLOYMENT.md) 及 `compose.mes-isolated.yaml` / `deploy-mes-release.sh` 是單獨的選用流程：專案 `mes`、服務 `mes-station`、volume `mes-mes-station-data`、loopback port 預設 `18095`。它只管理自己的服務，不使用本頁下方共享 `business-suite` project，不切換既有 edge，不接管 DNS。主機先安裝此 repo 的 release archive，再由核准的維運流程執行部署器。

這是獨立服務部署範本，不代表目前已連線或已部署至 OCI。現有 GitHub workflow 只驗證並發布 GHCR image；尚未配置受保護的主機部署環境或 SSH 上傳工作，因此不會在 push 時自動更新主機。

在主機部署前先按架構文件核對 SSH host key、權限、Compose project/volume 名稱及 port。archive 必須位於 `/srv/business-suite-mes/staging/`，呼叫時提供 Git commit SHA 及 archive SHA-256：

```bash
MES_DEPLOY_ROOT=/srv/business-suite-mes MES_DEPLOY_PORT=18095 \
  bash infra/linux/deploy-mes-release.sh <40-char-git-sha> <64-char-archive-sha256> \
  /srv/business-suite-mes/staging/<sha>.tgz
```

部署器只以 loopback `/api/health` 決定是否切換 `current`，失敗時回復 MES image/config，不刪除 volume；rollback 任一步失敗會以 exit 70 明確要求人工介入。Archive 僅接受普通檔案與目錄，拒絕 symlink、hardlink、特殊項目及路徑穿越。公開 hostname/TLS/反向代理仍需另外核准與外部驗收；本範本不建立或修改公開入口。`bash infra/linux/test-mes-deployment.sh` 會清除它建立的專用測試 Compose project、測試 volume 與唯一 `/tmp` 測試 root，也會驗證惡意 archive 拒絕及舊 image rollback；只能在空白隔離主機/checkout 執行，禁止在正式或共享主機執行。

此服務層供主站與六分站使用；可保留 Workers / D1，或加上正式 Node Web 容器。Node 適配器執行已建置的同一 fetch handler，將 D1 介面接到持久化 SQLite volume，並每分鐘派送 Outbox，不使用 `wrangler dev` 作為生產服務。

`bash linux/apply.sh --web` 部署整套到主機 loopback 8090；設定 MAIN_DOMAIN 與 DNS 後，`--public-web` 使用 Caddy HTTPS 開放主站。私有 gateway 不必另開公開網域。Node Web 為單實例，SQLite 是展示業務資料的權威來源；PostgreSQL 分片儲存新增工業／履約服務資料，既有 D1 資料需另行匯入，不能宣稱已自動遷移。

Linux 上按分站操作：`node scripts/infra.mjs plan mes --linux`、`node scripts/infra.mjs up shop --linux`。六個路徑共用 Web 容器，停止它會影響所有分站；分站的額外服務依賴仍由登錄表管理。

## 主站操作控制台

Linux `.env` 需有獨立 `PLATFORM_TOKEN`，至少 32 字元，不能沿用 `GATEWAY_TOKEN`。`/platform` 的服務管理以此憑證連線，憑證只保存在當次頁面的記憶體，不寫入瀏覽器儲存空間。展示角色 cookie 不授權主機操作。

獨立 control 容器透過 Docker Engine API 管理指定 Compose project 內、IaC graph 明列的服務；Web 容器不掛 Docker socket。介面只提供狀態、啟動、停止、重啟，不接受 shell 或任意 Docker API。新增與更新資源仍由版本化 Compose 發布流程執行。

操作前先建立 90 秒有效計畫，回傳步驟與受影響分站；執行時檢查容器身分、啟動時間、狀態與健康檢查是否仍符合規劃，計畫只能使用一次。操作結果寫入持久化 `control-audit` volume 的輪替 JSONL 紀錄。重啟 Web 會中斷當下頁面連線；待服務恢復後重新連線查詢狀態。

`python scripts/verify-control-graph.py` 比對控制範圍與實際 Compose；`node scripts/smoke-platform-control.mjs` 實測憑證隔離、collector 重啟、計畫重播及狀態漂移拒絕。此測試會重啟 collector，限維護或測試環境。

部署前取得 SSH alias / user@host、目標目錄與 gateway 網域。先確認主機 Docker Compose、磁碟容量、既有 80/443 使用者及 DNS，再上傳此 infra 目錄。不得覆寫遠端已有 `.env`；本機測試憑證不應複製到正式環境。

在遠端建立 `infra/.env`，填入獨立隨機密碼、token，以及 HTTPS 入口 `GATEWAY_DOMAIN`（純 hostname）。

```bash
# 有既有 Nginx / Caddy：只啟動服務，由既有代理轉送至 127.0.0.1:8088
bash linux/apply.sh

# 沒有既有代理且 80 / 443 空閒：使用隨附 Caddy 自動 TLS
bash linux/apply.sh --https
```

MQTT 及資料庫保持 Docker 私有網路。設備透過後續配置的 VPN／MQTT TLS 閘道接入；本範本不把內部 1883 公開。
主站執行環境設定 `INFRA_GATEWAY_URL=https://<gateway-host>` 及對應 `INFRA_GATEWAY_TOKEN`，並設定每分鐘排程派送 Outbox。

可使用 Workers cron，或隨附的 Linux systemd timer。後者在 `/etc/business-suite-main.env` 設定 `MAIN_URL` 與 `INFRA_GATEWAY_TOKEN`，權限 600；依實際安裝目錄調整 service 的 ExecStart，再安裝 service/timer 並 `systemctl enable --now business-suite-dispatch.timer`。服務端只接受服務 token，不接受展示角色 cookie。兩種排程擇一即可。

更新同一個 Compose project 可保留 volume；更新前備份兩個 PostgreSQL、TimescaleDB 與 D1。回滾應使用前版 source 與相容 schema，不得刪 volume 回復。

已知待辦：主機連線、DNS/TLS、主站正式執行環境與 cron 仍需在實際環境驗證。容器成功啟動不能代替正式連線驗收。

## GitHub Actions 自動部署

推送 `master` 時，`.github/workflows/engineering.yml` 先完成 Web、基礎設施和分站檢查，接著建置完整交付包，透過專用 SSH 金鑰部署至現有 OCI 主機。Pull Request 僅執行測試，不部署。部署工作序列化；若執行前已出現較新 commit，舊工作會失敗並停止，等待新版工作接手。

GitHub Actions repository secrets 必須設定 `OCI_DEPLOY_KEY` 與 `OCI_HOST_KEY`。前者對應主機部署帳號公鑰，後者為事先驗證的主機 SSH 公鑰；GitHub 管理員可讀取或修改 workflow，故取得該憑證等同取得主機部署帳號權限。主機沿用 `/srv/business-suite/shared/infra.env` 與既有資料 volumes，不將正式設定放進交付包。

部署前保存一致性的 Web SQLite 快照，並保留先前容器映像；更新服務或公開健康檢查失敗時嘗試恢復舊映像及設定。還原容器不等於還原資料庫結構，涉及不可逆資料庫遷移仍需另訂還原方案。GitHub Actions 紀錄是自動部署成功與否的依據。
