#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Destructive to only its explicitly named disposable test volumes. Never run on production.
project=mes-deploy-acceptance
probe_project=mes-deploy-isolation-probe
deploy_project="mes-deploy-acceptance-${RANDOM}-${RANDOM}"
sha=0123456789abcdef0123456789abcdef01234567
port=${MES_TEST_PORT:-18096}
test_volume="mes-mes-station-test-${RANDOM}-${RANDOM}"
compose_file="infra/linux/.compose-mes-test-${RANDOM}-${RANDOM}.yaml"
probe_file=$(mktemp)
probe_volume="mes-isolation-probe-${RANDOM}-${RANDOM}"
deploy_volume="mes-mes-station-acceptance-${RANDOM}-${RANDOM}"
deploy_root="/tmp/mes-deploy-acceptance-${RANDOM}-${RANDOM}"
deploy_port=${MES_TEST_DEPLOY_PORT:-18097}
deploy_container="${deploy_project}-mes-station-1"
deploy_archive="$deploy_root/staging/$sha.tgz"
rollback_sha=abcdef0123456789abcdef0123456789abcdef01
bad_archive="$deploy_root/staging/$rollback_sha.tgz"
cleanup() {
  local cleanup_failed=0
  if [[ -f "$compose_file" ]] && ! docker compose --project-name "$project" --file "$compose_file" down --volumes --remove-orphans; then
    echo "Cleanup failed for test project $project" >&2; cleanup_failed=1
  fi
  if [[ -s "$probe_file" ]] && ! docker compose --project-name "$probe_project" --file "$probe_file" down --volumes --remove-orphans; then
    echo "Cleanup failed for probe project $probe_project" >&2; cleanup_failed=1
  fi
  for volume in "$test_volume" "$probe_volume"; do
    if docker volume inspect "$volume" >/dev/null 2>&1 && ! docker volume rm "$volume"; then
      echo "Cleanup failed for test volume $volume" >&2; cleanup_failed=1
    fi
  done
  if [[ -f "$deploy_root/current/infra/linux/compose.mes-isolated.yaml" ]] && \
      ! MES_RELEASE_SHA="${deploy_sha:-$sha}" MES_DEPLOY_ROOT="$deploy_root" MES_DEPLOY_PORT="$deploy_port" MES_DEPLOY_PROJECT="$deploy_project" MES_DEPLOY_DATA_VOLUME="$deploy_volume" \
        docker compose --project-name "$deploy_project" --file "$deploy_root/current/infra/linux/compose.mes-isolated.yaml" down --volumes --remove-orphans; then
    echo "Cleanup failed for deployment test project $deploy_project; preserving $deploy_root" >&2; cleanup_failed=1
  fi
  case "$deploy_root" in
    /tmp/mes-deploy-acceptance-[0-9]*-[0-9]*)
      if ((cleanup_failed)); then
        :
      elif [[ ! -e "$deploy_root" && ! -L "$deploy_root" ]]; then
        :
      elif [[ -d "$deploy_root" && ! -L "$deploy_root" && "$(realpath -e -- "$deploy_root")" == "$deploy_root" ]]; then
        rm -rf -- "$deploy_root"
      else
        echo "Refusing cleanup of unresolved test root: $deploy_root" >&2
      fi
      ;;
    *) echo "Refusing cleanup of unexpected path: $deploy_root" >&2 ;;
  esac
  if ((cleanup_failed == 0)); then
    rm -f -- "$probe_file" "$compose_file" "${deploy_root}-escape"
  else
    return 1
  fi
}
[[ ! -e "$deploy_root" ]] || { echo "Unexpected test root already exists: $deploy_root" >&2; exit 2; }
[[ ! -e "${deploy_root}-escape" && ! -L "${deploy_root}-escape" ]] || { echo 'Unexpected archive escape target already exists' >&2; exit 2; }
command -v docker >/dev/null || { echo 'docker is required' >&2; exit 2; }
docker info >/dev/null || { echo 'Docker daemon is unavailable' >&2; exit 2; }
command -v git >/dev/null || { echo 'git is required' >&2; exit 2; }
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=${project}")" ]] || { echo "Test project already exists: $project" >&2; exit 2; }
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=${probe_project}")" ]] || { echo "Probe project already exists: $probe_project" >&2; exit 2; }
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=${deploy_project}")" ]] || { echo "Deploy project already exists: $deploy_project" >&2; exit 2; }
! docker volume inspect "$test_volume" >/dev/null 2>&1 || { echo "Test volume already exists: $test_volume" >&2; exit 2; }
! docker volume inspect "$probe_volume" >/dev/null 2>&1 || { echo "Probe volume already exists: $probe_volume" >&2; exit 2; }
! docker volume inspect "$deploy_volume" >/dev/null 2>&1 || { echo "Deploy volume already exists: $deploy_volume" >&2; exit 2; }
trap cleanup EXIT

[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((port >= 1024 && port <= 65535)) || { echo 'MES_TEST_PORT must be 1024..65535' >&2; exit 2; }
[[ "$deploy_port" =~ ^[0-9]{1,5}$ ]] && ((deploy_port >= 1024 && deploy_port <= 65535)) || { echo 'MES_TEST_DEPLOY_PORT must be 1024..65535' >&2; exit 2; }
[[ "$deploy_port" != "$port" ]] || { echo 'MES_TEST_PORT and MES_TEST_DEPLOY_PORT must differ' >&2; exit 2; }
[[ ! -e infra/.env ]] || { echo 'Refusing to run beside infra/.env; use a disposable isolated checkout' >&2; exit 2; }
command -v ss >/dev/null || { echo 'ss is required to verify the test port is free' >&2; exit 2; }
! ss -H -ltn "sport = :${port}" | grep -q . || { echo "Test port is already in use: $port" >&2; exit 2; }
! ss -H -ltn "sport = :${deploy_port}" | grep -q . || { echo "Deploy test port is already in use: $deploy_port" >&2; exit 2; }
export MES_RELEASE_SHA="$sha" MES_DEPLOY_PORT="$port"
sed "s|name: \${MES_DEPLOY_DATA_VOLUME:-mes-mes-station-data}|name: ${test_volume}|" infra/linux/compose.mes-isolated.yaml >"$compose_file"

docker compose --project-name "$project" --file "$compose_file" config --quiet
docker compose --project-name "$project" --file "$compose_file" up --build --detach --wait --wait-timeout 180
health="http://127.0.0.1:${port}/api/health"
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 2 "$health" >/dev/null
docker exec mes-deploy-acceptance-mes-station-1 test -s /srv/station/data/mes.sqlite

# Probe namespace isolation using unique disposable Docker objects.
cat >"$probe_file" <<EOF
services:
  probe:
    image: alpine:3.21
    command: ["sh", "-c", "echo isolated > /data/probe && sleep 300"]
    volumes:
      - probe-data:/data
volumes:
  probe-data:
    name: ${probe_volume}
EOF
docker volume create "$probe_volume" >/dev/null
docker compose --project-name "$probe_project" --file "$probe_file" up --detach
[[ "$(docker volume inspect --format '{{.Name}}' "$test_volume")" == "$test_volume" ]]
[[ "$(docker volume inspect --format '{{.Name}}' "$probe_volume")" == "$probe_volume" ]]
[[ "$(docker ps --filter "label=com.docker.compose.project=${project}" --filter status=running --format '{{.Names}}' | wc -l | tr -d ' ')" == 1 ]]
docker compose --project-name "$project" --file "$compose_file" restart
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 2 "$health" >/dev/null
docker exec mes-deploy-acceptance-mes-station-1 test -s /srv/station/data/mes.sqlite

docker compose --project-name "$probe_project" --file "$probe_file" down --volumes --remove-orphans >/dev/null

# Exercise archive type rejection and release rollback using a private /tmp root and unique Compose names.
mkdir -p "$deploy_root/staging" "$deploy_root/payload"
git archive --format=tar HEAD | gzip -n >"$deploy_archive"
deploy_sha=$(printf '%s' "$sha" | sha256sum | cut -c1-40)
deploy_digest=$(sha256sum "$deploy_archive" | cut -d' ' -f1)
if [[ -e "$deploy_root/current" || -e "$deploy_root/releases/$deploy_sha" ]]; then echo 'Unexpected test deploy state' >&2; exit 1; fi

for kind in symlink hardlink fifo traversal absolute; do
  case "$kind" in
    symlink) ln -s "${deploy_root}-escape" "$deploy_root/payload/unsafe"; printf marker >"$deploy_root/payload/marker"; tar --create --gzip --file "$deploy_root/staging/$kind.tgz" --directory "$deploy_root/payload" --transform='s|^marker$|unsafe/marker|' unsafe marker ;;
    hardlink) printf safe >"$deploy_root/payload/target"; ln "$deploy_root/payload/target" "$deploy_root/payload/unsafe"; tar --create --gzip --file "$deploy_root/staging/$kind.tgz" --directory "$deploy_root/payload" target unsafe ;;
    fifo) mkfifo "$deploy_root/payload/unsafe"; tar --create --gzip --file "$deploy_root/staging/$kind.tgz" --directory "$deploy_root/payload" unsafe ;;
    traversal) printf escape >"$deploy_root/payload/unsafe"; tar --absolute-names --create --gzip --file "$deploy_root/staging/$kind.tgz" --directory "$deploy_root/payload" --transform='s|unsafe|../mes-deploy-escape|' unsafe ;;
    absolute) printf escape >"$deploy_root/payload/unsafe"; tar --absolute-names --create --gzip --file "$deploy_root/staging/$kind.tgz" --directory "$deploy_root/payload" --transform="s|unsafe|${deploy_root}-escape|" unsafe ;;
  esac
  bad_digest=$(sha256sum "$deploy_root/staging/$kind.tgz" | cut -d' ' -f1)
  if MES_DEPLOY_ROOT="$deploy_root" MES_DEPLOY_PORT="$deploy_port" MES_DEPLOY_PROJECT="$deploy_project" MES_DEPLOY_DATA_VOLUME="$deploy_volume" \
      bash infra/linux/deploy-mes-release.sh "$deploy_sha" "$bad_digest" "$deploy_root/staging/$kind.tgz"; then
    echo "Unsafe $kind archive was accepted" >&2; exit 1
  fi
  rm -f "$deploy_root/payload/unsafe" "$deploy_root/payload/target" "$deploy_root/staging/$kind.tgz"
done
[[ ! -e "$deploy_root/mes-deploy-escape" && ! -L "$deploy_root/mes-deploy-escape" && ! -e "$deploy_root/releases/mes-deploy-escape" && ! -L "$deploy_root/releases/mes-deploy-escape" && ! -e "${deploy_root}-escape" && ! -L "${deploy_root}-escape" ]] || { echo 'Archive extraction escaped its temporary release directory' >&2; exit 1; }

MES_DEPLOY_ROOT="$deploy_root" MES_DEPLOY_PORT="$deploy_port" MES_DEPLOY_PROJECT="$deploy_project" MES_DEPLOY_DATA_VOLUME="$deploy_volume" \
  bash infra/linux/deploy-mes-release.sh "$deploy_sha" "$deploy_digest" "$deploy_archive"
current_before=$(readlink -f "$deploy_root/current")
image_before=$(docker inspect --format '{{.Image}}' "$deploy_container")
curl --fail --silent --show-error "http://127.0.0.1:${deploy_port}/api/health" >/dev/null

# A valid archive with an always-failing Compose healthcheck forces rollback after replacement.
mkdir -p "$deploy_root/bad-release"
tar --extract --gzip --file "$deploy_archive" --directory "$deploy_root/bad-release"
sed -i 's/"CMD", "\/srv\/station\/station-server", "--healthcheck"/"CMD", "false"/' "$deploy_root/bad-release/infra/linux/compose.mes-isolated.yaml"
(cd "$deploy_root/bad-release" && find . -type f -printf '%P\n' | tar --create --gzip --file "$bad_archive" --files-from=-)
bad_release_digest=$(sha256sum "$bad_archive" | cut -d' ' -f1)
if MES_DEPLOY_ROOT="$deploy_root" MES_DEPLOY_PORT="$deploy_port" MES_DEPLOY_PROJECT="$deploy_project" MES_DEPLOY_DATA_VOLUME="$deploy_volume" \
    bash infra/linux/deploy-mes-release.sh "$rollback_sha" "$bad_release_digest" "$bad_archive"; then
  echo 'Forced unhealthy release unexpectedly succeeded' >&2; exit 1
fi
[[ "$(readlink -f "$deploy_root/current")" == "$current_before" ]] || { echo 'Rollback changed current release symlink' >&2; exit 1; }
[[ "$(docker inspect --format '{{.Image}}' "$deploy_container")" == "$image_before" ]] || { echo 'Rollback did not restore prior image' >&2; exit 1; }
curl --fail --silent --show-error "http://127.0.0.1:${deploy_port}/api/health" >/dev/null

echo 'MES isolated Compose health, restart, and volume namespace checks passed.'
