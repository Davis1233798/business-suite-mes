#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'run as root on the dedicated MES host'
if [[ -e /srv/business-suite ]]; then
  for account in mes-deploy mes-runtime; do
    for permission in -r -x; do
      if runuser -u "$account" -- test "$permission" /srv/business-suite; then
        fail 'MES account can access shared portfolio data'
      else
        result=$?
        [[ "$result" -eq 1 ]] || fail 'Shared-data isolation probe failed'
      fi
    done
  done
fi

for account in mes-deploy mes-runtime; do
  getent passwd "$account" >/dev/null || fail "missing account: $account"
  [[ " $(id -nG "$account") " != *' docker '* ]] || fail "$account belongs to rootful docker group"
  if [[ -S /var/run/docker.sock ]] && runuser -u "$account" -- test -r /var/run/docker.sock; then
    fail "$account can read the rootful Docker socket"
  fi
done
[[ "$(id -u mes-deploy)" != "$(id -u mes-runtime)" ]] || fail 'deploy and runtime accounts must be distinct'
runtime_home=$(getent passwd mes-runtime | cut -d: -f6)
[[ -d "$runtime_home" && $(stat -c '%a' "$runtime_home") == 700 ]] || fail 'mes-runtime home must be private mode 0700'
if runuser -u mes-deploy -- test -x "$runtime_home"; then fail 'deploy account can traverse mes-runtime home'; fi
if runuser -u mes-deploy -- test -x /srv/business-suite-mes; then fail 'deploy account can traverse runtime release/data paths'; fi
deploy_sudo=$(sudo -n -l -U mes-deploy 2>&1 || true)
if grep -Eq '\(ALL(:ALL)?\)|ALL' <<<"$deploy_sudo"; then
  fail 'deploy account has broad sudo or arbitrary Docker privileges'
fi
sudo_commands=$(grep -E '^    \(' <<<"$deploy_sudo" | sed 's/^[[:space:]]*//')
[[ "$sudo_commands" == '(root) NOPASSWD: /usr/local/sbin/mes-deploy-gateway' ]] || fail 'deploy account must have exactly one fixed gateway sudo rule'
runtime_sudo=$(sudo -n -l -U mes-runtime 2>&1 || true)
runtime_commands=$(grep -E '^    \(' <<<"$runtime_sudo" || true)
[[ -z "$runtime_commands" ]] || fail 'runtime account must not have sudo commands'

gateway=/usr/local/sbin/mes-deploy-gateway
[[ -f "$gateway" && ! -L "$gateway" ]] || fail 'fixed gateway is missing or is a symlink'
[[ $(stat -c '%U:%G:%a' "$gateway") == root:root:750 ]] || fail 'gateway must be root-owned and not writable by deploy/runtime accounts'
root=/srv/business-suite-mes
[[ -d "$root" && ! -L "$root" && $(stat -c '%U:%G:%a' "$root") == mes-runtime:mes-runtime:750 ]] || fail 'MES release root must be a mes-runtime-owned private directory'
[[ -d "$root/staging" && ! -L "$root/staging" && $(stat -c '%U:%G:%a' "$root/staging") == mes-runtime:mes-runtime:750 ]] || fail 'MES staging directory must be owned privately by mes-runtime'
[[ -d /run/mes-deploy-inbox && ! -L /run/mes-deploy-inbox && $(stat -c '%U:%G:%a' /run/mes-deploy-inbox) == root:mes-runtime:710 ]] || fail 'gateway inbox must be root-owned and traversable by mes-runtime under root-controlled /run'
[[ -f "$root/.mes-deploy-owner" && ! -L "$root/.mes-deploy-owner" && $(stat -c '%U:%a' "$root/.mes-deploy-owner") == root:444 && $(cat "$root/.mes-deploy-owner") == business-suite-mes/v1 ]] || fail 'MES owner marker is missing or invalid'

runtime_uid=$(id -u mes-runtime)
runtime_dir="/run/user/$runtime_uid"
[[ -d "$runtime_dir" && -S "$runtime_dir/docker.sock" && ! -L "$runtime_dir/docker.sock" && $(stat -c '%U' "$runtime_dir/docker.sock") == mes-runtime ]] || fail 'mes-runtime rootless daemon socket is unavailable or owned by another account'
security=$(runuser -u mes-runtime -- env HOME="$(getent passwd mes-runtime | cut -d: -f6)" XDG_RUNTIME_DIR="$runtime_dir" DOCKER_HOST="unix://$runtime_dir/docker.sock" docker info --format '{{json .SecurityOptions}}')
[[ "$security" == *'"name=rootless"'* ]] || fail 'mes-runtime is connected to a rootful Docker daemon'

effective=$(sshd -T -C "user=mes-deploy,host=$(hostname -f),addr=127.0.0.1")
grep -Fq 'forcecommand /usr/bin/sudo -n /usr/local/sbin/mes-deploy-gateway "$SSH_ORIGINAL_COMMAND"' <<<"$effective" || fail 'effective SSH ForceCommand is not the gateway'
grep -Fq 'permittty no' <<<"$effective" || fail 'SSH TTY must be disabled'
grep -Fq 'disableforwarding yes' <<<"$effective" || fail 'SSH forwarding must be disabled'
grep -Fq 'allowtcpforwarding no' <<<"$effective" || fail 'SSH TCP forwarding must be disabled'
grep -Fq 'allowstreamlocalforwarding no' <<<"$effective" || fail 'SSH stream-local forwarding must be disabled'
grep -Fq 'allowagentforwarding no' <<<"$effective" || fail 'SSH agent forwarding must be disabled'
grep -Fq 'x11forwarding no' <<<"$effective" || fail 'SSH X11 forwarding must be disabled'
grep -Fq 'passwordauthentication no' <<<"$effective" || fail 'SSH password authentication must be disabled'
grep -Fq 'kbdinteractiveauthentication no' <<<"$effective" || fail 'SSH keyboard-interactive authentication must be disabled'
grep -Fq 'authenticationmethods publickey' <<<"$effective" || fail 'SSH must require public-key authentication'

sudo -n "$gateway" status >/dev/null || fail 'forced-command gateway health/isolation status check failed'
printf 'PASS: dedicated MES host uses rootless Docker; deploy key reaches only the fixed gateway and cannot access the rootful daemon.\n'
