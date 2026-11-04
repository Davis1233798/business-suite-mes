# 首次建立 MES OCI rootless 主機

本文件說明首次在既有 Ubuntu 24.04 ARM64 OCI 主機建立 MES rootless runtime。Provisioner 是明確的兩階段命令：`--check` 僅讀取主機狀態並輸出檢查結果；`--apply` 才安裝所需 Ubuntu 套件、建立帳號與權限、安裝固定 gateway 設定並啟動 `mes-runtime` 的 user-level Docker daemon。兩種模式都要求 root，且都拒絕不符合條件或無法辨識的既有狀態。

它會保留已運作的 rootful `docker.io` daemon、socket、container、volume、image 和 package。不得停用、重啟、升級、替換 rootful Docker；不得加入 `docker` 群組；不得安裝會與 Ubuntu `docker.io` / `rootlesskit` 衝突的 `docker-ce-rootless-extras`。Rootless daemon 使用現有 Docker Engine 29.x 及本 repo 固定的 Moby `docker-v29.1.3` rootless setup scripts。Ubuntu 的 `rootlesskit` 必須位於 `/usr/bin/rootlesskit`，由 Ubuntu AppArmor profile 授權 user namespace。Provisioner 不停用 AppArmor、不調低全機 user namespace 限制，也不以全域 `sysctl` 覆蓋安全政策。

## 權限邊界

- `mes-runtime` 與 `mes-deploy` 是不同的 system account、私有 home 與 primary group。`mes-runtime` 無 sudo、無 `docker` 群組、無 rootful socket 權限；user daemon 以 linger 在開機後運行。其 Docker API 僅由 runtime UID 的 `/run/user/<uid>/docker.sock` 提供。
- `mes-deploy` 僅有固定 root-owned gateway 的無密碼 sudo 權限；SSH `ForceCommand` 只轉交原始命令給 gateway，停用密碼、TTY、轉送和 user rc。帳號不配置登入金鑰；維運人員稍後才可透過專用 GitHub Environment 外部管理金鑰。Shell 保持可執行 ForceCommand 的狀態，無互動 shell 是由 sshd policy 強制。
- 若 `/srv/business-suite` 存在，僅在該根目錄 ACL 為兩個 MES UID 加入明確的無權限項目。原 owner、既有 ACL 及 rootful 服務權限須保留；驗收會用兩個帳號實際探測拒絕讀取與穿越。Provisioner 不遞迴重寫共享樹 ACL。
- `/srv/business-suite-mes` 由 `mes-runtime` 擁有；根目錄 marker 及 `/etc` 下的 provisioner marker 用來識別此工具建立的資源。若遇到既有帳號、路徑、ACL 身分或 marker 與管理資料不符，工具拒絕接管，不刪除或覆寫。
- Root gateway 的短期上傳 inbox 為 `/run/mes-deploy-inbox`，由 systemd tmpfiles 建立為 `root:mes-runtime`、mode `0710`。Runtime 只有路徑穿越能力；gateway 暫存上傳為 `root:mes-runtime`、mode `0640`，再由 runtime 自己複製到 staging。
- 此方案分隔 Linux 帳號、Docker daemon、MES 服務和資料目錄，但仍共用 Linux kernel，不提供 VM 等級隔離。它不建立公開 ingress、DNS、TLS 或 Caddy route。

## 操作順序

先在維護時段確認實際主機、rootful Docker 29.x、Compose v2、磁碟容量、既有 `/srv/business-suite` ACL 與 18095 loopback port；不要把此腳本指向其他主機。先預覽檢查：

```bash
sudo bash infra/linux/provision-mes-rootless-host.sh --check
```

檢查成功後，只有在需要建立此隔離 runtime 時才執行：

```bash
sudo bash infra/linux/provision-mes-rootless-host.sh --apply
```

套用完成後以唯讀方式驗證：

```bash
sudo bash infra/linux/provision-mes-rootless-host.sh --check
sudo bash infra/linux/test-mes-host-isolation.sh
```

此處不建立或安裝部署 SSH key、不開啟 `MES_DEPLOY_ENABLED`、不設定 GitHub secrets，也不切換公開路由。部署啟用仍須完成 GitHub Environment 核准與實際 host key 驗證。若 provisioner 中途失敗，保留診斷狀態並修復後重新跑 `--check`；不會自動刪除帳號、ACL、套件、Docker 資料或 rollback 共享資源。

## 驗收

GitHub Actions 的 disposable `ubuntu-24.04-arm` job 在隔離 VM 上執行 `--check` 和 `--apply`，同時保留 rootful Docker sentinel 容器與 volume；再驗證 rootless service、AppArmor、UID/GID mapping、帳號隔離、共享樹 ACL 拒絕，以及 MES test-only Compose project 的建置、health、資料持久與 rollback。該 job 不使用 OCI secrets，不在 production OCI 執行清理型測試，也不註冊為 self-hosted runner。Production 是否部署仍由既有 `mes-production` GitHub Environment gated workflow 控制。
