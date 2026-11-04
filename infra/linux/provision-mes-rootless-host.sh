#!/usr/bin/env bash
# First-time, fail-closed MES rootless host provisioning.
set -Eeuo pipefail
umask 077

readonly MES_PROVISIONER_VERSION='business-suite-mes/host-provisioner/v1'
readonly STATE='/etc/mes-oci-provisioner'
readonly STATE_MARKER="$STATE/owner"
readonly MES_ROOT='/srv/business-suite-mes'
readonly MES_MARKER="$MES_ROOT/.mes-deploy-owner"
readonly SHARED_ROOT='/srv/business-suite'
readonly VENDOR_REL='infra/linux/rootless-vendor'
readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly VENDOR="$REPO_ROOT/$VENDOR_REL"
readonly ROOTLESS_BIN='/usr/local/libexec/mes-rootless'
readonly GATEWAY='/usr/local/sbin/mes-deploy-gateway'
readonly SUDOERS='/etc/sudoers.d/mes-deploy'
readonly TMPFILES='/etc/tmpfiles.d/mes-deploy.conf'
readonly SSHD='/etc/ssh/sshd_config'
readonly RUNTIME='mes-runtime'
readonly DEPLOY='mes-deploy'
readonly PACKAGES=(acl apparmor dbus-user-session rootlesskit slirp4netns uidmap)
MODE=''
SSH_BACKUP=''

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
exists_path() { [[ -e "$1" || -L "$1" ]]; }
owned_regular() {
  [[ -f "$1" && ! -L "$1" ]] || return 1
  [[ $(stat -c '%u:%g:%a' -- "$1") == '0:0:444' ]]
}
root_owned_dir() {
  [[ -d "$1" && ! -L "$1" ]] || return 1
  [[ $(stat -c '%u:%g:%a' -- "$1") == "0:0:$2" ]]
}
account_exists() { getent passwd "$1" >/dev/null 2>&1; }
group_exists() { getent group "$1" >/dev/null 2>&1; }
acl_text() {
  python3 - "$1" <<'PY'
import errno, os, struct, sys
try:
    raw = os.getxattr(os.fsencode(sys.argv[1]), b"system.posix_acl_access", follow_symlinks=False)
except OSError as exc:
    if exc.errno in (getattr(errno, "ENODATA", 61), getattr(errno, "ENOATTR", 93)):
        raise SystemExit(0)
    raise
if len(raw) < 4 or (len(raw) - 4) % 8 or raw[:4] != b"\x02\x00\x00\x00":
    raise SystemExit("unrecognized POSIX ACL encoding")
names = {1: "user_obj", 2: "user", 4: "group_obj", 8: "group", 16: "mask", 32: "other"}
for offset in range(4, len(raw), 8):
    tag, perm, ident = struct.unpack_from("<HHI", raw, offset)
    qualifier = f":{ident}" if tag in (2, 8) else ""
    mode = "".join(("r" if perm & 4 else "-", "w" if perm & 2 else "-", "x" if perm & 1 else "-"))
    print(f"{names.get(tag, 'unknown')}{qualifier}:{mode}")
PY
}

usage() { echo "Usage: sudo bash $0 --check|--apply"; }
[[ $# -eq 1 ]] || { usage >&2; exit 2; }
case "$1" in --check) MODE=check ;; --apply) MODE=apply ;; *) usage >&2; exit 2 ;; esac
[[ $EUID -eq 0 ]] || fail 'run as root'

for path in /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/getent /usr/sbin/visudo /usr/sbin/sshd /usr/sbin/runuser /usr/bin/python3; do
  [[ -x "$path" ]] || fail "required Ubuntu command missing: $path"
done
/usr/sbin/sshd -t || fail 'existing SSH configuration/runtime is invalid; no provisioning changes made'
[[ -f "$VENDOR/dockerd-rootless.sh" && -f "$VENDOR/dockerd-rootless-setuptool.sh" && -f "$VENDOR/LICENSE" && -f "$VENDOR/SOURCE.md" ]] || fail 'pinned rootless vendor files are incomplete'
printf '%s  %s\n' \
  '8eb00d61b5e78ffc0dcd628f056389b5859cc61d6fe3ce17b4a3a4b08143c8a5' "$VENDOR/dockerd-rootless.sh" \
  'e68ef6550fea1b5c01b5cc7a400a6b44ee28159d7714758c3845759e03e079dc' "$VENDOR/dockerd-rootless-setuptool.sh" \
  '7c87873291f289713ac5df48b1f2010eb6963752bbd6b530416ab99fc37914a8' "$VENDOR/LICENSE" | sha256sum --check --status || fail 'vendored rootless source digest mismatch'

[[ -r /etc/os-release ]] || fail 'cannot identify host operating system'
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || fail 'requires Ubuntu 24.04'
[[ $(dpkg --print-architecture) == arm64 ]] || fail 'requires Ubuntu ARM64'
[[ $(uname -m) == aarch64 ]] || fail 'requires an ARM64 kernel'
[[ $(systemd-detect-virt --container 2>/dev/null || true) != container ]] || fail 'requires a VM/host systemd, not a container'
[[ -d /run/systemd/system ]] || fail 'systemd is not running'
[[ -r /sys/fs/cgroup/cgroup.controllers ]] || fail 'cgroup v2 is required'

docker_bin=$(command -v docker || true)
[[ $docker_bin == /usr/bin/docker ]] || fail 'expected the Ubuntu rootful docker.io client at /usr/bin/docker'
docker_service=$(systemctl is-active docker.service 2>/dev/null || true)
[[ $docker_service == active ]] || fail 'existing rootful Docker service must already be active'
server_version=$(docker info --format '{{.ServerVersion}}' 2>/dev/null) || fail 'rootful Docker daemon is unavailable'
[[ $server_version == 29.* ]] || fail 'existing rootful Docker Engine must be 29.x'
docker_root=$(docker info --format '{{.DockerRootDir}}')
[[ -n $docker_root && -d $docker_root ]] || fail 'cannot verify rootful Docker data root'
for target_fs in /var/lib /srv; do
  [[ -d $target_fs && ! -L $target_fs ]] || fail "expected real target filesystem directory: $target_fs"
  available_kib=$(df --output=avail -k -- "$target_fs" | tail -n 1 | tr -d ' ')
  [[ $available_kib =~ ^[0-9]+$ ]] && (( available_kib >= 8 * 1024 * 1024 )) || fail "at least 8 GiB must be free on the target filesystem containing $target_fs"
done
docker_compose=$(docker compose version --short 2>/dev/null || true)
[[ -n $docker_compose ]] || fail 'rootful Docker Compose v2 plugin is required'

if [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] && [[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns) != 1 ]]; then
  fail 'Ubuntu user-namespace AppArmor restriction is not enabled'
fi
if [[ -r /proc/sys/kernel/unprivileged_userns_clone ]] && [[ $(cat /proc/sys/kernel/unprivileged_userns_clone) != 1 ]]; then
  fail 'unprivileged user namespaces are disabled by host policy'
fi
command -v aa-status >/dev/null && aa-status --enabled || fail 'AppArmor must be enabled'

managed_state=0
if exists_path "$STATE"; then
  root_owned_dir "$STATE" 750 || fail "$STATE exists with foreign ownership or mode"
  owned_regular "$STATE_MARKER" || fail 'host provisioner marker is missing, unsafe, or foreign'
  [[ $(cat "$STATE_MARKER") == "$MES_PROVISIONER_VERSION" ]] || fail 'host provisioner marker has an unknown owner/version'
  managed_state=1
fi

if (( ! managed_state )); then
  for name in "$RUNTIME" "$DEPLOY"; do
    account_exists "$name" && fail "refusing to adopt pre-existing account $name"
    group_exists "$name" && fail "refusing to adopt pre-existing group $name"
  done
  for path in "$MES_ROOT" "$MES_MARKER" "$GATEWAY" "$SUDOERS" "$TMPFILES" "$ROOTLESS_BIN"; do
    exists_path "$path" && fail "refusing to adopt pre-existing path $path"
  done
  for path in /var/lib/mes-runtime /var/lib/mes-deploy /run/mes-deploy-inbox; do
    exists_path "$path" && fail "refusing to adopt pre-existing path $path"
  done
  for path in /etc/subuid /etc/subgid; do
    if exists_path "$path"; then
      [[ -f "$path" && ! -L "$path" && $(stat -c '%u:%g' "$path") == '0:0' ]] || fail "subordinate ID database is not a root-owned regular file: $path"
      subid_mode=$(stat -c '%a' "$path")
      (( (8#$subid_mode & 0022) == 0 )) || fail "subordinate ID database is writable by non-root: $path"
    fi
  done
  grep -Eq '^mes-runtime:' /etc/subuid /etc/subgid 2>/dev/null && fail 'refusing to adopt existing mes-runtime subordinate ID mappings'
  [[ -e "$SSHD" && ! -L "$SSHD" ]] || fail 'expected regular /etc/ssh/sshd_config'
  [[ $(stat -c '%u:%g' "$SSHD") == '0:0' ]] || fail 'SSH config must be root-owned'
  sshd_mode=$(stat -c '%a' "$SSHD")
  (( (8#$sshd_mode & 0022) == 0 )) || fail 'SSH config must not be group/world writable'
  if grep -Fq 'Match User mes-deploy' "$SSHD"; then fail 'SSH config already contains a mes-deploy policy'; fi
  planned_uid=450
  while getent passwd "$planned_uid" >/dev/null || getent passwd "$((planned_uid + 1))" >/dev/null || getent group "$planned_uid" >/dev/null || getent group "$((planned_uid + 1))" >/dev/null; do planned_uid=$((planned_uid + 1)); done
  (( planned_uid < 60000 )) || fail 'no free system UID pair is available'
  exists_path "/run/user/$planned_uid" && fail "refusing to adopt pre-existing runtime path /run/user/$planned_uid"
  planned_sub_start=200000
  while awk -F: -v s="$planned_sub_start" -v e="$((planned_sub_start + 65535))" '$2 <= e && $2+$3-1 >= s {found=1} END{exit !found}' /etc/subuid /etc/subgid 2>/dev/null; do planned_sub_start=$((planned_sub_start + 65536)); done
  (( planned_sub_start + 65535 < 4294967295 )) || fail 'no free subordinate UID/GID range found'
  if [[ -e "$SHARED_ROOT" ]]; then
    candidate_acl=$(acl_text "$SHARED_ROOT") || fail 'cannot inspect numeric shared-root ACL identities'
    for candidate in "$planned_uid" "$((planned_uid + 1))"; do
      grep -Eq "^(user|group):${candidate}:" <<<"$candidate_acl" && fail "shared-root ACL already assigns proposed numeric identity $candidate"
    done
  fi
else
  account_exists "$RUNTIME" && account_exists "$DEPLOY" || fail 'managed account is missing; refusing automatic repair'
  [[ -d "$MES_ROOT" && ! -L "$MES_ROOT" ]] || fail 'managed MES root is missing or unsafe'
  [[ -f "$MES_MARKER" && ! -L "$MES_MARKER" && $(cat "$MES_MARKER") == business-suite-mes/v1 ]] || fail 'managed MES marker is invalid'
  [[ -f "$GATEWAY" && ! -L "$GATEWAY" ]] || fail 'managed gateway is missing or unsafe'
  [[ -f "$SUDOERS" && ! -L "$SUDOERS" ]] || fail 'managed sudoers file is missing or unsafe'
  [[ -f "$TMPFILES" && ! -L "$TMPFILES" ]] || fail 'managed tmpfiles file is missing or unsafe'
  [[ -d "$ROOTLESS_BIN" && ! -L "$ROOTLESS_BIN" ]] || fail 'managed rootless bin directory is missing or unsafe'
  cmp -s "$ROOTLESS_BIN/dockerd-rootless.sh" "$VENDOR/dockerd-rootless.sh" || fail 'installed rootless daemon launcher differs from pinned source'
  cmp -s "$ROOTLESS_BIN/dockerd-rootless-setuptool.sh" "$VENDOR/dockerd-rootless-setuptool.sh" || fail 'installed rootless setup tool differs from pinned source'
  [[ -L "$ROOTLESS_BIN/docker" && $(readlink "$ROOTLESS_BIN/docker") == /usr/bin/docker ]] || fail 'rootless tool Docker client link is missing or unexpected'
fi

if [[ -e "$SHARED_ROOT" || -L "$SHARED_ROOT" ]]; then
  [[ -d "$SHARED_ROOT" && ! -L "$SHARED_ROOT" && $(stat -c '%u' "$SHARED_ROOT") != 0 ]] || fail 'shared root must be an existing non-symlink directory owned by its current service owner'
  current_acl=$(acl_text "$SHARED_ROOT") || fail 'cannot read shared-root ACL'
  if (( managed_state )); then
    runtime_uid=$(id -u "$RUNTIME"); deploy_uid=$(id -u "$DEPLOY")
    grep -Eq "^user:${runtime_uid}:---$" <<<"$current_acl" || fail 'managed runtime deny ACL is missing; refusing mutation'
    grep -Eq "^user:${deploy_uid}:---$" <<<"$current_acl" || fail 'managed deploy deny ACL is missing; refusing mutation'
  fi
fi

if (( ! managed_state )); then
  # Ensure package resolution cannot upgrade or remove the live rootful engine.
  package_plan=$(apt-get -s install --no-upgrade --no-remove "${PACKAGES[@]}" 2>&1) || fail 'Ubuntu package simulation failed'
  if grep -Eiq '^(Remv|Inst) (docker\.io|docker-ce|containerd|containerd\.io|runc)(:| )' <<<"$package_plan"; then
    fail 'package plan would alter the existing container engine/runtime'
  fi
  for package in "${PACKAGES[@]}"; do
    apt-cache show "$package" >/dev/null 2>&1 || fail "Ubuntu package unavailable: $package"
  done
fi

if (( managed_state )); then
  [[ $(stat -c '%u:%g:%a' "$GATEWAY") == '0:0:750' ]] || fail 'managed gateway has unexpected ownership/mode'
  cmp -s "$GATEWAY" "$REPO_ROOT/infra/linux/mes-deploy-gateway.py" || fail 'managed gateway source differs; refusing overwrite'
  [[ $(stat -c '%u:%g:%a' "$SUDOERS") == '0:0:440' ]] || fail 'managed sudoers has unexpected ownership/mode'
  cmp -s "$SUDOERS" "$REPO_ROOT/infra/linux/mes-deploy.sudoers" || fail 'managed sudoers differs; refusing overwrite'
  [[ $(stat -c '%u:%g:%a' "$TMPFILES") == '0:0:644' ]] || fail 'managed tmpfiles config has unexpected ownership/mode'
  grep -Fxq "d /run/mes-deploy-inbox 0710 root $RUNTIME -" "$TMPFILES" || fail 'managed tmpfiles inbox policy differs'
  [[ $(stat -c '%u:%g:%a' "$ROOTLESS_BIN") == '0:0:755' ]] || fail 'managed rootless bin directory has unexpected ownership/mode'
  visudo -cf "$SUDOERS" >/dev/null || fail 'managed sudo policy is invalid'
  sshd -t || fail 'current sshd configuration is invalid'
  effective=$(sshd -T -C "user=$DEPLOY,host=$(hostname -f),addr=127.0.0.1")
  grep -Fq 'forcecommand /usr/bin/sudo -n /usr/local/sbin/mes-deploy-gateway "$SSH_ORIGINAL_COMMAND"' <<<"$effective" || fail 'effective SSH policy no longer enforces the gateway'
  loginctl show-user "$RUNTIME" --property=Linger --value | grep -qx yes || fail 'mes-runtime user linger is not enabled'
  aa-status --enabled || fail 'AppArmor is disabled'
  [[ -f /etc/apparmor.d/rootlesskit ]] || fail 'Ubuntu rootlesskit AppArmor profile is missing'
  aa-status | grep -Fq rootlesskit || fail 'Ubuntu rootlesskit AppArmor profile is not loaded'
  runtime_uid=$(id -u "$RUNTIME")
  [[ -S "/run/user/$runtime_uid/docker.sock" && $(stat -c '%U:%a' "/run/user/$runtime_uid/docker.sock") == "$RUNTIME:600" ]] || fail 'managed rootless Docker socket is unavailable or unsafe'
  rootless_security=$(runuser -u "$RUNTIME" -- env -i HOME=/var/lib/mes-runtime XDG_RUNTIME_DIR="/run/user/$runtime_uid" DOCKER_HOST="unix:///run/user/$runtime_uid/docker.sock" docker info --format '{{json .SecurityOptions}}' 2>/dev/null) || fail 'managed rootless Docker daemon is unavailable'
  [[ $rootless_security == *'"name=rootless"'* ]] || fail 'MES Docker daemon is not rootless'
  [[ $(systemctl is-active docker.service) == active && $(docker info --format '{{.ServerVersion}}') == "$server_version" ]] || fail 'rootful Docker service/version changed'
  note 'Managed host marker found; auditing the existing installation.'
fi
if ss -H -ltn 'sport = :18095' | grep -q .; then
  (( managed_state )) || fail 'TCP port 18095 is already in use on an unmanaged host'
  runtime_uid=$(id -u "$RUNTIME")
  runtime_socket="unix:///run/user/$runtime_uid/docker.sock"
  managed_ids=$(runuser -u "$RUNTIME" -- env -i HOME=/var/lib/mes-runtime XDG_RUNTIME_DIR="/run/user/$runtime_uid" DOCKER_HOST="$runtime_socket" /usr/bin/docker ps -q --filter 'label=com.docker.compose.project=business-suite-mes' --filter status=running) || fail 'cannot verify the managed MES container owning TCP port 18095'
  [[ $(wc -w <<<"$managed_ids" | tr -d ' ') == 1 ]] || fail 'TCP port 18095 is occupied without exactly one managed MES container'
  "$GATEWAY" status >/dev/null || fail 'TCP port 18095 is not owned by a healthy, gateway-verified MES service'
fi
if (( managed_state )); then bash "$REPO_ROOT/infra/linux/test-mes-host-isolation.sh"; fi
note "Preflight passed: Ubuntu 24.04 ARM64, rootful Docker $server_version and Compose $docker_compose remain active; mode=$MODE."
if [[ $MODE == check ]]; then exit 0; fi
if (( managed_state )); then
  note 'Host is already provisioned and audited; --apply made no changes.'
  exit 0
fi

trap 'rc=$?; if (( rc != 0 )); then printf "Provisioning stopped (status %s); no broad cleanup was attempted. Inspect %s and rerun --check after repair.\n" "$rc" "$STATE" >&2; fi' EXIT
  install -d -o root -g root -m 0750 "$STATE"
  printf '%s\n' "$MES_PROVISIONER_VERSION" > "$STATE_MARKER"
  chown root:root "$STATE_MARKER"; chmod 0444 "$STATE_MARKER"

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-upgrade --no-remove "${PACKAGES[@]}"

  # Pick unused system UIDs and reserve one contiguous subordinate range.
  uid=$planned_uid
  sub_start=$planned_sub_start
  [[ -e /etc/subuid ]] || install -o root -g root -m 0644 /dev/null /etc/subuid
  [[ -e /etc/subgid ]] || install -o root -g root -m 0644 /dev/null /etc/subgid

  groupadd --system --gid "$uid" "$RUNTIME"
  useradd --system --uid "$uid" --gid "$RUNTIME" --home-dir /var/lib/mes-runtime --create-home --shell /usr/sbin/nologin "$RUNTIME"
  groupadd --system --gid "$((uid + 1))" "$DEPLOY"
  useradd --system --uid "$((uid + 1))" --gid "$DEPLOY" --home-dir /var/lib/mes-deploy --create-home --shell /bin/bash "$DEPLOY"
  passwd -l "$RUNTIME" >/dev/null
  passwd -l "$DEPLOY" >/dev/null
  chmod 0700 /var/lib/mes-runtime /var/lib/mes-deploy
  # Ubuntu uses /etc/subuid and /etc/subgid; preserve all other mappings.
  printf '%s:%s:65536\n' "$RUNTIME" "$sub_start" >> /etc/subuid
  printf '%s:%s:65536\n' "$RUNTIME" "$sub_start" >> /etc/subgid
  chown root:root /etc/subuid /etc/subgid; chmod 0644 /etc/subuid /etc/subgid

  if [[ -d "$SHARED_ROOT" ]]; then
    acl_backup="$STATE/business-suite.acl.before"
    getfacl -p -- "$SHARED_ROOT" > "$acl_backup"
    chmod 0600 "$acl_backup"
    if acl_text "$SHARED_ROOT" | grep -q '^mask:'; then
      setfacl -n -m "u:$((uid + 1)):---,u:$uid:---" -- "$SHARED_ROOT"
    else
      setfacl -m "u:$((uid + 1)):---,u:$uid:---" -- "$SHARED_ROOT"
    fi
  fi

  install -d -o "$RUNTIME" -g "$RUNTIME" -m 0750 "$MES_ROOT" "$MES_ROOT/staging" "$MES_ROOT/releases"
  printf '%s\n' business-suite-mes/v1 > "$MES_MARKER"
  chown root:root "$MES_MARKER"; chmod 0444 "$MES_MARKER"
  install -d -o root -g root -m 0755 "$ROOTLESS_BIN"
  install -o root -g root -m 0755 "$VENDOR/dockerd-rootless.sh" "$ROOTLESS_BIN/dockerd-rootless.sh"
  install -o root -g root -m 0755 "$VENDOR/dockerd-rootless-setuptool.sh" "$ROOTLESS_BIN/dockerd-rootless-setuptool.sh"
  install -o root -g root -m 0644 "$VENDOR/LICENSE" "$ROOTLESS_BIN/LICENSE"
  install -o root -g root -m 0644 "$VENDOR/SOURCE.md" "$ROOTLESS_BIN/SOURCE.md"
  ln -s /usr/bin/docker "$ROOTLESS_BIN/docker"

  install -o root -g root -m 0750 "$REPO_ROOT/infra/linux/mes-deploy-gateway.py" "$GATEWAY"
  install -o root -g root -m 0440 "$REPO_ROOT/infra/linux/mes-deploy.sudoers" "$SUDOERS"
  printf 'd /run/mes-deploy-inbox 0710 root %s -\n' "$RUNTIME" > "$TMPFILES"
  chown root:root "$TMPFILES"; chmod 0644 "$TMPFILES"
  visudo -cf "$SUDOERS" >/dev/null
  systemd-tmpfiles --create "$TMPFILES"

  # Append the Match block at EOF, preserving all existing SSH policy.
  SSH_BACKUP="$STATE/sshd_config.before"
  cp -a -- "$SSHD" "$SSH_BACKUP"
  printf '\n' >> "$SSHD"
  cat "$REPO_ROOT/infra/linux/sshd-mes-deploy.conf" >> "$SSHD"
  if ! sshd -t; then cp -a "$SSH_BACKUP" "$SSHD"; fail 'sshd rejected the appended MES policy; original config restored'; fi
  effective=$(sshd -T -C "user=$DEPLOY,host=$(hostname -f),addr=127.0.0.1")
  grep -Fq 'forcecommand /usr/bin/sudo -n /usr/local/sbin/mes-deploy-gateway "$SSH_ORIGINAL_COMMAND"' <<<"$effective" || { cp -a "$SSH_BACKUP" "$SSHD"; fail 'effective SSH policy does not force the fixed gateway'; }
  grep -Fq 'authenticationmethods publickey' <<<"$effective" || { cp -a "$SSH_BACKUP" "$SSHD"; fail 'SSH policy does not require public key authentication'; }
  chmod 0600 "$SSH_BACKUP"
  if systemctl is-active --quiet ssh.service; then
    if ! systemctl reload ssh.service; then
      cp -a "$SSH_BACKUP" "$SSHD"
      systemctl reload ssh.service || true
      fail 'sshd reload failed; original SSH config was restored'
    fi
  fi

runtime_uid=$(id -u "$RUNTIME")
[[ $(getent passwd "$RUNTIME" | cut -d: -f6) == /var/lib/mes-runtime ]] || fail 'runtime home path differs from managed layout'
[[ $(getent passwd "$DEPLOY" | cut -d: -f6) == /var/lib/mes-deploy ]] || fail 'deploy home path differs from managed layout'
[[ " $(id -nG "$RUNTIME") " != *' docker '* && " $(id -nG "$DEPLOY") " != *' docker '* ]] || fail 'MES account is in rootful docker group'
[[ $(stat -c '%u:%g:%a' /var/lib/mes-runtime) == "$(id -u "$RUNTIME"):$(id -g "$RUNTIME"):700" ]] || fail 'runtime home ownership/mode is unsafe'
[[ $(stat -c '%u:%g:%a' /var/lib/mes-deploy) == "$(id -u "$DEPLOY"):$(id -g "$DEPLOY"):700" ]] || fail 'deploy home ownership/mode is unsafe'

aa-status --enabled || fail 'AppArmor became disabled'
[[ -f /etc/apparmor.d/rootlesskit && ! -L /etc/apparmor.d/rootlesskit ]] || fail 'Ubuntu rootlesskit AppArmor profile is unavailable'
apparmor_parser -r /etc/apparmor.d/rootlesskit
aa-status | grep -Fq rootlesskit || fail 'Ubuntu rootlesskit AppArmor profile is not loaded'
loginctl enable-linger "$RUNTIME"
for attempt in $(seq 1 20); do [[ -S "/run/user/$runtime_uid/bus" ]] && break; sleep 1; done
[[ -S "/run/user/$runtime_uid/bus" ]] || fail 'runtime user systemd bus did not appear after enabling linger'
runuser -u "$RUNTIME" -- env -i \
  HOME=/var/lib/mes-runtime USER="$RUNTIME" LOGNAME="$RUNTIME" \
  XDG_RUNTIME_DIR="/run/user/$runtime_uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runtime_uid/bus" \
  PATH="$ROOTLESS_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$ROOTLESS_BIN/dockerd-rootless-setuptool.sh" install --force

for attempt in $(seq 1 30); do
  if runuser -u "$RUNTIME" -- env -i HOME=/var/lib/mes-runtime XDG_RUNTIME_DIR="/run/user/$runtime_uid" DOCKER_HOST="unix:///run/user/$runtime_uid/docker.sock" docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q '"name=rootless"'; then break; fi
  sleep 2
done
runuser -u "$RUNTIME" -- env -i HOME=/var/lib/mes-runtime XDG_RUNTIME_DIR="/run/user/$runtime_uid" DOCKER_HOST="unix:///run/user/$runtime_uid/docker.sock" docker info --format '{{json .SecurityOptions}}' | grep -q '"name=rootless"' || fail 'rootless Docker daemon did not become ready'
[[ $(stat -c '%U:%a' "/run/user/$runtime_uid/docker.sock") == "$RUNTIME:600" ]] || fail 'rootless Docker socket owner/mode is unsafe'
[[ $(systemctl is-active docker.service) == active ]] || fail 'rootful Docker service was disrupted'
[[ $(docker info --format '{{.ServerVersion}}') == "$server_version" ]] || fail 'rootful Docker version changed during provisioning'
bash "$REPO_ROOT/infra/linux/test-mes-host-isolation.sh"
note 'MES rootless host provisioning completed. No deployment SSH key or production enablement was configured.'
