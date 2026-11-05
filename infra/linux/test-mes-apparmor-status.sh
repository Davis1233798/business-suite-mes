#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=infra/linux/mes-apparmor-status.sh
source "$SCRIPT_DIR/mes-apparmor-status.sh"

fake_bin="$(mktemp -d)"
trap 'rm -rf -- "$fake_bin"' EXIT
cat > "$fake_bin/aa-status" <<'FAKE_AA_STATUS'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${FAKE_AA_STATUS_CASE:-large}" in
  large)
    printf 'rootlesskit\n'
    python3 -c 'import sys; sys.stdout.write("unrelated-profile\n" * 100000)'
    ;;
  missing)
    printf 'unrelated-profile\n'
    python3 -c 'import sys; sys.stdout.write("unrelated-profile\n" * 100000)'
    ;;
  failed-after-match)
    printf 'rootlesskit\n'
    exit 23
    ;;
  *)
    printf 'unexpected test case\n' >&2
    exit 24
    ;;
esac
FAKE_AA_STATUS
chmod 0755 "$fake_bin/aa-status"
export PATH="$fake_bin:$PATH"

FAKE_AA_STATUS_CASE=large
export FAKE_AA_STATUS_CASE
mes_rootlesskit_profile_loaded || { echo 'large match-first status output was rejected' >&2; exit 1; }

FAKE_AA_STATUS_CASE=missing
export FAKE_AA_STATUS_CASE
if mes_rootlesskit_profile_loaded; then
  echo 'status output without rootlesskit was accepted' >&2
  exit 1
fi

FAKE_AA_STATUS_CASE=failed-after-match
export FAKE_AA_STATUS_CASE
if mes_rootlesskit_profile_loaded; then
  echo 'nonzero aa-status with a matching line was accepted' >&2
  exit 1
fi

echo 'PASS: AppArmor status reader drains large output and preserves producer failures.'
