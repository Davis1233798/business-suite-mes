#!/usr/bin/env bash
set -Eeuo pipefail

sha=${1:?usage: deploy-mes-release.sh <40-char-git-sha> <64-char-archive-sha256> <archive-path>}
expected=${2:?archive SHA-256 required}
archive=${3:?archive path required}
root=${MES_DEPLOY_ROOT:-/srv/business-suite-mes}
port=${MES_DEPLOY_PORT:-18095}
project=${MES_DEPLOY_PROJECT:-business-suite-mes}
data_volume=${MES_DEPLOY_DATA_VOLUME:-business-suite-mes-station-data}
service=mes-station
compose_file=infra/linux/compose.mes-isolated.yaml

[[ "$sha" =~ ^[0-9a-f]{40}$ && "$expected" =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid git SHA or archive SHA-256' >&2; exit 2; }
[[ "$root" == /srv/business-suite-mes || "$root" =~ ^/tmp/mes-deploy-acceptance-[0-9]+-[0-9]+$ ]] || { echo 'MES_DEPLOY_ROOT must be the production root or a uniquely named test root under /tmp' >&2; exit 2; }
if [[ "$root" == /srv/business-suite-mes ]]; then
  [[ "$project" == business-suite-mes && "$data_volume" == business-suite-mes-station-data && "$port" == 18095 ]] || { echo 'Production project, data volume, and port are fixed to the isolated MES namespace' >&2; exit 2; }
  [[ -f "$root/.mes-deploy-owner" && ! -L "$root/.mes-deploy-owner" ]] || { echo 'Production root is not provisioned with an MES owner marker' >&2; exit 2; }
  [[ "$(cat "$root/.mes-deploy-owner")" == business-suite-mes/v1 ]] || { echo 'Production root owner marker does not match this MES deployment' >&2; exit 2; }
else
  [[ "$project" =~ ^mes-deploy-acceptance-[0-9]+-[0-9]+$ && "$data_volume" =~ ^mes-mes-station-acceptance-[0-9]+-[0-9]+$ ]] || { echo 'Test roots require unique test-only project and data volume names' >&2; exit 2; }
fi
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{0,50}$ && "$data_volume" =~ ^[a-z0-9][a-z0-9_-]{0,100}$ ]] || { echo 'Invalid MES Compose project or volume name' >&2; exit 2; }
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((port >= 1024 && port <= 65535)) || { echo 'MES_DEPLOY_PORT must be 1024..65535' >&2; exit 2; }
[[ -f "$archive" && ! -L "$archive" ]] || { echo 'Archive must be a regular file, not a symlink' >&2; exit 2; }
[[ ! -L "$root" ]] || { echo 'MES deployment root must not be a symlink' >&2; exit 2; }
if [[ "$root" == /srv/business-suite-mes ]]; then
  [[ -d "$root" && ! -L "$root" && -d "$root/releases" && ! -L "$root/releases" && -d "$root/staging" && ! -L "$root/staging" ]] || { echo 'Production MES root and subdirectories must be provisioned before deployment' >&2; exit 2; }
else
  install -d -m 0750 "$root/releases" "$root/staging"
fi
[[ "$(realpath -e -- "$root")" == "$root" && ! -L "$root/releases" && ! -L "$root/staging" ]] || { echo 'MES deployment directories must resolve inside the fixed deployment root' >&2; exit 2; }
[[ "$(realpath -e -- "$root/releases")" == "$root/releases" && "$(realpath -e -- "$root/staging")" == "$root/staging" ]] || { echo 'MES deployment directories must not escape the fixed deployment root' >&2; exit 2; }
archive_real=$(realpath -e -- "$archive")
staging_real=$(realpath -e -- "$root/staging")
[[ "$archive_real" == "$staging_real/"* ]] || { echo 'Archive must be under the MES staging directory' >&2; exit 2; }
if [[ "$root" == /srv/business-suite-mes || "${MES_REQUIRE_ROOTLESS_DOCKER:-0}" == 1 ]]; then
  [[ "$(id -un)" == mes-runtime && "$(id -u)" -ne 0 ]] || { echo 'Production MES deployment must run as the non-root mes-runtime account' >&2; exit 1; }
  expected_socket="unix:///run/user/$(id -u)/docker.sock"
  [[ "${DOCKER_HOST:-}" == "$expected_socket" && -S "/run/user/$(id -u)/docker.sock" ]] || { echo 'Production MES deployment must use mes-runtime rootless Docker socket' >&2; exit 1; }
  docker_security=$(docker info --format '{{json .SecurityOptions}}')
  [[ "$docker_security" == *'"name=rootless"'* ]] || { echo 'Production MES deployment refuses a rootful Docker daemon' >&2; exit 1; }
else
  docker info >/dev/null
fi
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another MES deployment is running' >&2; exit 1; }

if docker volume inspect "$data_volume" >/dev/null 2>&1; then
  volume_project=$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$data_volume")
  volume_key=$(docker volume inspect --format '{{ index .Labels "com.docker.compose.volume" }}' "$data_volume")
  [[ "$volume_project" == "$project" && "$volume_key" == mes-station-data ]] || { echo "Named volume $data_volume is not owned by the isolated MES Compose project" >&2; exit 1; }
fi

verified_archive="$root/.verified-$sha-$$.tgz"
[[ ! -e "$verified_archive" && ! -L "$verified_archive" ]] || { echo 'Verified archive temporary path already exists' >&2; exit 1; }
extract_dir=''
cleanup_extract() {
  if [[ -n "$extract_dir" ]]; then
    case "$extract_dir" in
      "$root/releases/.extract-$sha."*)
        if [[ -d "$extract_dir" && ! -L "$extract_dir" && "$(realpath -e -- "$extract_dir")" == "$extract_dir" ]]; then
          rm -rf -- "$extract_dir"
          extract_dir=''
        else
          echo "Refusing to clean unresolved extraction directory: $extract_dir" >&2
          return 1
        fi
        ;;
      *) echo "Refusing to clean unexpected extraction path: $extract_dir" >&2; return 1 ;;
    esac
  fi
}
cleanup_temporary_files() {
  cleanup_extract
  rm -f -- "$verified_archive"
}
trap cleanup_temporary_files EXIT
install -m 0600 "$archive_real" "$verified_archive"
printf '%s  %s\n' "$expected" "$verified_archive" | sha256sum --check --status || { echo 'Archive SHA-256 mismatch' >&2; exit 1; }

release="$root/releases/$sha"
[[ ! -e "$release" ]] || { echo "Release already exists: $release" >&2; exit 1; }
extract_dir=$(mktemp -d "$root/releases/.extract-$sha.XXXXXX")
if [[ -L "$root/current" ]]; then
  previous=$(realpath -e -- "$root/current")
elif [[ -e "$root/current" ]]; then
  echo 'MES current path exists but is not a symlink' >&2
  exit 1
else
  previous=''
fi
project_containers=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")
all_project_containers=$(docker ps -aq --filter "label=com.docker.compose.project=$project")
for container in $all_project_containers; do
  container_service=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$container")
  [[ "$container_service" == "$service" ]] || { echo "Compose project $project contains an unexpected service; refusing to mutate it" >&2; exit 1; }
done
previous_image=''
if [[ -n "$project_containers" ]]; then
  [[ "$project_containers" != *$'\n'* ]] || { echo 'More than one MES service container exists; refusing ambiguous rollback' >&2; exit 1; }
  previous_image=$(docker inspect --format '{{.Image}}' "$project_containers")
fi
[[ -z "$previous" || "$previous" == "$root/releases/"* ]] || { echo 'Current release symlink escapes MES release root' >&2; exit 1; }
previous_sha=''
if [[ -n "$previous" && -f "$previous/COMMIT" ]]; then
  previous_sha=$(cat "$previous/COMMIT")
  [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Current release has an invalid COMMIT marker' >&2; exit 1; }
fi

if ! MES_ARCHIVE="$verified_archive" MES_RELEASE_DIR="$extract_dir" python3 - <<'PY'
import os
import pathlib
import tarfile

archive = os.environ["MES_ARCHIVE"]
destination = pathlib.Path(os.environ["MES_RELEASE_DIR"]).resolve(strict=True)
seen = set()

with tarfile.open(archive, mode="r:gz") as bundle:
    members = bundle.getmembers()
    if not members:
        raise SystemExit("Refusing an empty archive")
    for member in members:
        name = member.name
        clean_name = name.rstrip("/")
        path = pathlib.PurePosixPath(clean_name)
        if not clean_name or "\\" in name or path.is_absolute() or any(part in ("", ".", "..") for part in clean_name.split("/")):
            raise SystemExit(f"Refusing unsafe archive path: {name!r}")
        if clean_name in seen:
            raise SystemExit(f"Refusing duplicate archive path: {name!r}")
        seen.add(clean_name)
        if not (member.isdir() or member.type in (tarfile.REGTYPE, tarfile.AREGTYPE)):
            raise SystemExit(f"Refusing link or special archive item: {name!r}")
        target = (destination / pathlib.Path(*path.parts)).resolve(strict=False)
        if os.path.commonpath((str(destination), str(target))) != str(destination):
            raise SystemExit(f"Archive path escapes release directory: {name!r}")

    for member in members:
        path = pathlib.Path(*pathlib.PurePosixPath(member.name).parts)
        target = destination / path
        if member.isdir():
            target.mkdir(mode=0o750, parents=True, exist_ok=True)
            if not target.is_dir() or target.is_symlink():
                raise SystemExit(f"Refusing non-directory path: {member.name!r}")
            continue
        target.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        if target.parent.is_symlink() or not target.parent.is_dir():
            raise SystemExit(f"Refusing unsafe parent path: {member.name!r}")
        source = bundle.extractfile(member)
        if source is None:
            raise SystemExit(f"Could not read archive file: {member.name!r}")
        with source, target.open("xb") as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
        target.chmod(0o755 if member.mode & 0o111 else 0o644)
PY
then
  cleanup_extract
  echo 'Archive validation/extraction failed; no release was installed.' >&2
  exit 1
fi
if [[ ! -f "$extract_dir/infra/linux/compose.mes-isolated.yaml" || ! -f "$extract_dir/infra/linux/Dockerfile.station" ]]; then
  cleanup_extract
  echo 'Archive is missing MES isolated deployment files' >&2
  exit 1
fi
if [[ -e "$extract_dir/infra/.env" || -L "$extract_dir/infra/.env" ]]; then
  cleanup_extract
  echo 'Refusing an archive containing infra/.env' >&2
  exit 1
fi
printf '%s\n' "$sha" >"$extract_dir/COMMIT"
mv -- "$extract_dir" "$release"
extract_dir=''

compose() {
  local dir=$1; shift
  (cd "$dir" && MES_RELEASE_SHA="$sha" MES_DEPLOY_PORT="$port" MES_DEPLOY_DATA_VOLUME="$data_volume" docker compose --project-name "$project" --file "$compose_file" "$@")
}

rollback() {
  local status=$?
  trap - ERR
  echo "MES release failed ($status); restoring MES service image and previous release" >&2
  local rollback_failed=0
  rollback_step() {
    local label=$1
    shift
    if "$@"; then
      printf 'Rollback step succeeded: %s\n' "$label" >&2
    else
      printf 'ROLLBACK STEP FAILED: %s\n' "$label" >&2
      rollback_failed=1
    fi
  }
  restore_previous_release() {
    docker tag "$previous_image" "business-suite-mes-station:$previous_sha" && \
      (cd "$previous" && MES_RELEASE_SHA="$previous_sha" MES_DEPLOY_PORT="$port" MES_DEPLOY_DATA_VOLUME="$data_volume" docker compose --project-name "$project" --file "$compose_file" up --detach --no-build --no-deps --force-recreate "$service") && \
      (cd "$previous" && MES_RELEASE_SHA="$previous_sha" MES_DEPLOY_PORT="$port" MES_DEPLOY_DATA_VOLUME="$data_volume" docker compose --project-name "$project" --file "$compose_file" up --detach --no-build --no-deps --wait --wait-timeout 180 "$service")
  }
  if [[ -n "$previous_image" && -n "$previous" && -n "$previous_sha" ]]; then
    rollback_step 'restore previous image and Compose release' restore_previous_release
  elif [[ -n "$previous_image" ]]; then
    restore_first_image() {
      docker tag "$previous_image" "business-suite-mes-station:$sha" && \
        compose "$release" up --detach --no-build --no-deps --force-recreate "$service" && \
        compose "$release" up --detach --no-build --no-deps --wait --wait-timeout 180 "$service"
    }
    rollback_step 'restore prior image for pre-existing MES service' restore_first_image
  else
    rollback_step 'remove newly created MES project service' compose "$release" down --remove-orphans
  fi
  if [[ -n "$previous_image" ]]; then
    rollback_step 'verify restored MES health endpoint' curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 2 "http://127.0.0.1:${port}/api/health"
  fi
  if ((rollback_failed)); then
    echo 'CRITICAL: MES deployment failed and rollback was incomplete; operator intervention is required.' >&2
    exit 70
  fi
  echo 'MES rollback completed and the prior health endpoint is responding.' >&2
  exit "$status"
}
trap rollback ERR

compose "$release" config --quiet
compose "$release" build "$service"
compose "$release" up --detach --no-deps --wait --wait-timeout 180 "$service"
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 2 "http://127.0.0.1:${port}/api/health" >/dev/null

tmp_link="$root/.current-$sha"
ln -s "$release" "$tmp_link"
mv -Tf "$tmp_link" "$root/current"
trap - ERR
printf 'Deployed MES commit %s to %s (project=%s service=%s port=127.0.0.1:%s)\n' "$sha" "$release" "$project" "$service" "$port"
