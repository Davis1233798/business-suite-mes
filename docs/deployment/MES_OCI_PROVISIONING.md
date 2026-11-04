# 首次建立 MES OCI rootless 主機

本文件說明首次在既有 Ubuntu 24.04 ARM64 OCI 主機建立 MES rootless runtime。Provisioner 是明確的兩階段命令：`--check` 僅讀取主機狀態並輸出檢查結果；`--apply` 才安裝所需 Ubuntu 套件、建立帳號與權限、安裝固定 gateway 設定並啟動 `mes-runtime` 的 user-level Docker daemon。兩種模式都要求 root，且都拒絕不符合條件或無法辨識的既有狀態。

它會保留已運作的 rootful `docker.io` daemon、socket、container、volume、image 和 package。不得停用、重啟、升級、替換 rootful Docker；不得加入 `docker` 群組；不得安裝會與 Ubuntu `docker.io` / `rootlesskit` 衝突的 `docker-ce-rootless-extras`。Rootless daemon 使用現有 Docker Engine 29.x 及本 repo 固定的 Moby `docker-v29.1.3` rootless setup scripts。Ubuntu 的 `rootlesskit` 必須位於 `/usr/bin/rootlesskit`，由 Ubuntu AppArmor profile 授權 user namespace。Provisioner 不停用 AppArmor、不調低全機 user namespace 限制，也不以全域 `sysctl` 覆蓋安全政策。

Provisioner 只透過 Ubuntu 套件安裝 `acl`, `apparmor`, `dbus-user-session`, `rootlesskit`, `slirp4netns`, `uidmap`。首次 `--check` 以既有 apt package index 執行模擬，不更新 index；`--apply` 才執行 `apt-get update` 並安裝這些套件。預檢分別確認 `/var/lib`（`mes-runtime` rootless Docker data）及 `/srv`（MES releases）所在檔案系統各有至少 8 GiB 可用空間；rootful Docker 的 data filesystem 可能不同，因此不以它代替這兩項檢查。

## 權限邊界

- `mes-runtime` 與 `mes-deploy` 是不同的 system account、私有 home 與 primary group。`mes-runtime` 無 sudo、無 `docker` 群組、無 rootful socket 權限；user daemon 以 linger 在開機後運行。其 Docker API 僅由 runtime UID 的 `/run/user/<uid>/docker.sock` 提供。
- `mes-deploy` 僅有固定 root-owned gateway 的無密碼 sudo 權限；SSH `ForceCommand` 只轉交原始命令給 gateway，停用密碼、TTY、轉送和 user rc。帳號不配置登入金鑰；維運人員稍後才可透過專用 GitHub Environment 外部管理金鑰。Shell 保持可執行 ForceCommand 的狀態，無互動 shell 是由 sshd policy 強制。
- 若 `/srv/business-suite` 存在，僅在該根目錄 ACL 為兩個 MES UID 加入明確的無權限項目。原 owner、既有 ACL 及 rootful 服務權限須保留；驗收會用兩個帳號實際探測拒絕讀取與穿越。Provisioner 不遞迴重寫共享樹 ACL。
- `/srv/business-suite-mes` 由 `mes-runtime` 擁有；根目錄 marker 及 `/etc` 下的 provisioner marker 用來識別此工具建立的資源。若遇到既有帳號、路徑、ACL 身分或 marker 與管理資料不符，工具拒絕接管，不刪除或覆寫。
- Root gateway 的短期上傳 inbox 為 `/run/mes-deploy-inbox`，由 systemd tmpfiles 建立為 `root:mes-runtime`、mode `0710`。Runtime 只有路徑穿越能力；gateway 暫存上傳為 `root:mes-runtime`、mode `0640`，再由 runtime 自己複製到 staging。
- 此方案分隔 Linux 帳號、Docker daemon、MES 服務和資料目錄，但仍共用 Linux kernel，不提供 VM 等級隔離。它不建立公開 ingress、DNS、TLS 或 Caddy route。

## 操作順序

先在維護時段確認實際主機、rootful Docker 29.x、Compose v2、磁碟容量與既有 `/srv/business-suite` ACL；不要把此腳本指向其他主機。初次安裝時，18095 loopback port 必須空閒。已管理主機若該 port 被占用，只在固定 root gateway 驗證恰好一個預期 rootless MES container、固定 `127.0.0.1:18095` mapping 及健康回應後才允許檢查；任意 process 的 listener 仍會被拒絕。完整主機重跑 `--apply` 會先執行稽核後直接返回，不會重啟 daemon。先預覽檢查：

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

Provisioner 不會建立部署 SSH key，也不會開啟 `MES_DEPLOY_ENABLED`、設定 GitHub secrets 或切換公開路由。部署啟用仍須完成 GitHub Environment 核准與實際 host key 驗證。若 provisioner 中途失敗，保留診斷狀態；不會自動刪除帳號、ACL、套件、Docker 資料或 rollback 共享資源。管理 marker 代表此主機曾開始由 provisioner 管理，不保證中途失敗時已完成。未完成狀態會拒絕自動重跑；維運人員須比對 root marker、ACL 備份、SSH 備份與服務實況後人工修復，再使用 `--check`。不得刪除 marker 來強制重跑。

## 驗收

GitHub Actions 的 disposable `ubuntu-24.04-arm` job 在 runner VM 上先移除預裝的 Docker 28 packages，並由 Ubuntu Noble archive 安裝 `docker.io=29.1.3-0ubuntu3~24.04.2` 與 Ubuntu `docker-compose-v2`。這個替換只發生在 disposable CI VM，讓驗收符合 OCI 的 Ubuntu `docker.io` 29.x 前置條件；production provisioner 仍拒絕升級、替換或重啟既有 rootful Docker。CI 先以臨時非 MES listener 驗證未管理主機會拒絕被占用的 18095 port，再於 rootless runtime 部署一個有效 MES release，證明已管理主機接受 gateway 驗證通過的預期服務 listener，並拒絕 MES container 停止時由臨時非 MES listener 占用的同一 port。CI 另在空 port 情況執行 `--check` 與連續兩次 `--apply`，同時保留 rootful Docker sentinel 容器與 volume；第二次套用必須只稽核並返回，不重啟或替換服務。接著驗證 rootless service、AppArmor、UID/GID mapping、帳號隔離、共享樹 ACL 拒絕，以及 MES test-only Compose project 的建置、health、資料持久與 rollback。該 job 不使用 OCI secrets，不在 production OCI 執行清理型測試，也不註冊為 self-hosted runner。Production 是否部署仍由既有 `mes-production` GitHub Environment gated workflow 控制。

## 上游依據

- Docker 的 [rootless troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/) 說明 Ubuntu 24.04 預設限制 unprivileged user namespaces，並要求以 AppArmor profile 授權；不要求停用整體保護。
- Ubuntu Noble 的 [apparmor package file list](https://packages.ubuntu.com/noble/all/apparmor/filelist) 包含 `/etc/apparmor.d/rootlesskit`。
- Rootless setup scripts 與授權文字固定於 Moby [`docker-v29.1.3`](https://github.com/moby/moby/tree/docker-v29.1.3/contrib) tag；來源 revision 與 SHA-256 列於 `infra/linux/rootless-vendor/SOURCE.md`。

Runtime commands use a clean environment with explicit private HOME, PATH and rootless socket/runtime paths. Caller XDG and Docker configuration must not redirect mes-runtime into the operator or CI home. ARM64 acceptance supplies inaccessible caller config paths and verifies they are never created.
