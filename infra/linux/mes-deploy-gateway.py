#!/usr/bin/python3
"""Root-owned SSH forced-command gateway for MES release uploads."""

import hashlib
import grp
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import stat
import urllib.request

ROOT = Path("/srv/business-suite-mes")
SHARED_ROOT = Path("/srv/business-suite")
STAGING = ROOT / "staging"
# Root's inbox is under /run: all ancestors are root-controlled, unlike
# ROOT and its descendants, which are runtime-owned and renameable.
INBOX = Path("/run/mes-deploy-inbox")
MAX_ARCHIVE = 1024 * 1024 * 1024
MAX_EXPANDED_ARCHIVE = 2 * 1024 * 1024 * 1024
MAX_MEMBERS = 100_000
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
PROJECT = "business-suite-mes"
VOLUME = "business-suite-mes-station-data"
PORT = "18095"


class GatewayError(Exception):
    pass


def runtime_context():
    account = pwd.getpwnam("mes-runtime")
    runtime_dir = Path(f"/run/user/{account.pw_uid}")
    socket_path = runtime_dir / "docker.sock"
    if not runtime_dir.is_dir() or not socket_path.exists():
        raise GatewayError("mes-runtime rootless Docker socket is unavailable")
    socket_stat = socket_path.lstat()
    if not stat.S_ISSOCK(socket_stat.st_mode) or socket_stat.st_uid != account.pw_uid:
        raise GatewayError("MES Docker socket is not a socket owned by mes-runtime")
    env = {
        "HOME": account.pw_dir,
        "USER": account.pw_name,
        "LOGNAME": account.pw_name,
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "XDG_RUNTIME_DIR": str(runtime_dir),
        "DOCKER_HOST": f"unix://{socket_path}",
    }
    return account, env


def runtime(*args, **kwargs):
    account, env = runtime_context()
    check = kwargs.pop("check", True)
    return subprocess.run(
        ["/usr/sbin/runuser", "-u", account.pw_name, "--", "/usr/bin/env", *[f"{k}={v}" for k, v in env.items()], *args],
        check=check,
        **kwargs,
    )


def assert_rootless():
    result = runtime("/usr/bin/docker", "info", "--format", "{{json .SecurityOptions}}", capture_output=True, text=True)
    if '"name=rootless"' not in result.stdout:
        raise GatewayError("mes-runtime Docker daemon is not rootless")


def assert_shared_tree_inaccessible(accounts):
    if not SHARED_ROOT.exists():
        return
    for account in accounts:
        for permission in ('-r', '-x'):
            result = subprocess.run(['/usr/sbin/runuser', '-u', account.pw_name, '--', '/usr/bin/test', permission, str(SHARED_ROOT)])
            if result.returncode != 1:
                raise GatewayError('MES account can access shared portfolio data or its isolation probe failed')


def assert_host_boundary():
    if os.geteuid() != 0:
        raise GatewayError("gateway must be installed and run as root")
    deploy_account = pwd.getpwnam("mes-deploy")
    runtime_account = pwd.getpwnam("mes-runtime")
    if deploy_account.pw_uid in (0, runtime_account.pw_uid) or runtime_account.pw_uid == 0:
        raise GatewayError("mes-deploy and mes-runtime must be distinct non-root accounts")
    assert_shared_tree_inaccessible((deploy_account, runtime_account))
    for account in (deploy_account, runtime_account):
        group_names = {grp.getgrgid(gid).gr_name for gid in os.getgrouplist(account.pw_name, account.pw_gid)}
        if "docker" in group_names:
            raise GatewayError(f"{account.pw_name} is in the rootful docker group")
        if Path("/var/run/docker.sock").exists() and subprocess.run(["/usr/sbin/runuser", "-u", account.pw_name, "--", "/usr/bin/test", "-r", "/var/run/docker.sock"]).returncode == 0:
            raise GatewayError(f"{account.pw_name} can read the rootful Docker socket")
    runtime_home = Path(runtime_account.pw_dir)
    if runtime_home.is_symlink() or not runtime_home.is_dir() or runtime_home.stat().st_uid != runtime_account.pw_uid or stat.S_IMODE(runtime_home.stat().st_mode) != 0o700:
        raise GatewayError("mes-runtime home must be private and owned by mes-runtime")
    if subprocess.run(["/usr/sbin/runuser", "-u", deploy_account.pw_name, "--", "/usr/bin/test", "-x", str(runtime_home)]).returncode == 0:
        raise GatewayError("mes-deploy can traverse mes-runtime home")
    if ROOT.is_symlink() or not ROOT.is_dir() or ROOT.stat().st_uid != runtime_account.pw_uid or ROOT.stat().st_gid != runtime_account.pw_gid or stat.S_IMODE(ROOT.stat().st_mode) != 0o750:
        raise GatewayError("MES deployment root is missing, unsafe, or not owned by mes-runtime")
    if subprocess.run(["/usr/sbin/runuser", "-u", deploy_account.pw_name, "--", "/usr/bin/test", "-x", str(ROOT)]).returncode == 0:
        raise GatewayError("mes-deploy can traverse MES runtime release/data paths")
    marker = ROOT / ".mes-deploy-owner"
    if marker.is_symlink() or not marker.is_file() or marker.stat().st_uid != 0 or stat.S_IMODE(marker.stat().st_mode) != 0o444 or marker.read_text(encoding="ascii").strip() != "business-suite-mes/v1":
        raise GatewayError("MES deployment owner marker is missing or invalid")
    if STAGING.is_symlink() or not STAGING.is_dir() or STAGING.stat().st_uid != runtime_account.pw_uid or STAGING.stat().st_gid != runtime_account.pw_gid:
        raise GatewayError("MES staging directory must be owned by mes-runtime")
    assert_root_inbox()


def validate_root_inbox(inbox, anchor, owner_uid, group_gid):
    """Require a private inbox and root-controlled ancestry from a trusted anchor."""
    inbox = Path(inbox)
    anchor = Path(anchor)
    if not inbox.is_absolute() or inbox.name != "mes-deploy-inbox" or inbox.parent != anchor:
        raise GatewayError("MES root inbox path is not fixed")
    current = anchor
    for candidate in (anchor, inbox):
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
            raise GatewayError("MES root inbox has an unsafe or non-root-controlled ancestor")
    info = inbox.stat()
    if info.st_gid != group_gid or stat.S_IMODE(info.st_mode) != 0o710:
        raise GatewayError("MES root inbox must be root-owned mode 0710 for runtime read access")


def assert_root_inbox():
    """Require a root-private inbox whose full path has no runtime-writable ancestor."""
    validate_root_inbox(INBOX, Path("/run"), 0, grp.getgrnam("mes-runtime").gr_gid)


def open_deploy_lock():
    lock_path = INBOX / "gateway.lock"
    flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open(lock_path, flags, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        os.close(fd)
        raise GatewayError("MES gateway lock must be a root-owned regular file with mode 0600")
    return fd


def check_status():
    assert_host_boundary()
    assert_rootless()
    ids = runtime(
        "/usr/bin/docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={PROJECT}",
        capture_output=True, text=True,
    ).stdout.split()
    volume = runtime(
        "/usr/bin/docker", "volume", "inspect", "--format", "{{ index .Labels \"com.docker.compose.project\" }}:{{ index .Labels \"com.docker.compose.volume\" }}", VOLUME,
        capture_output=True, text=True, check=False,
    )
    if volume.returncode == 0 and volume.stdout.strip() != f"{PROJECT}:mes-station-data":
        raise GatewayError("MES data volume is missing or outside its project namespace")
    if volume.returncode != 0 and "no such volume" not in volume.stderr.lower():
        raise GatewayError("MES rootless Docker volume inspection failed")
    if volume.returncode != 0 and ids:
        raise GatewayError("running MES service is missing its isolated data volume")
    if len(ids) > 1:
        raise GatewayError("MES Compose project contains multiple containers")
    if ids:
        container = ids[0]
        service = runtime(
            "/usr/bin/docker", "inspect", "--format", "{{ index .Config.Labels \"com.docker.compose.service\" }}", container,
            capture_output=True, text=True,
        ).stdout.strip()
        health = runtime(
            "/usr/bin/docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container,
            capture_output=True, text=True,
        ).stdout.strip()
        state = runtime(
            "/usr/bin/docker", "inspect", "--format", "{{.State.Status}}", container,
            capture_output=True, text=True,
        ).stdout.strip()
        published = runtime(
            "/usr/bin/docker", "port", container, "8095/tcp",
            capture_output=True, text=True,
        ).stdout.strip()
        if service != "mes-station" or health != "healthy" or state != "running" or published != f"127.0.0.1:{PORT}":
            raise GatewayError("MES service identity or health check failed")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=4) as response:
                health_json = json.load(response)
        except Exception as exc:
            raise GatewayError("loopback MES health endpoint is unavailable") from exc
        if health_json.get("success") is not True or health_json.get("data") != {"backend": "go", "status": "ready"}:
            raise GatewayError("loopback MES health response is invalid")
    print(json.dumps({"protocol": 1, "ready": True, "runtime_user": "mes-runtime", "docker_mode": "rootless", "project": PROJECT, "data_volume": VOLUME, "port": f"127.0.0.1:{PORT}"}, separators=(",", ":")))


def extract_deploy_script(archive):
    contents = None
    total = 0
    count = 0
    with tarfile.open(archive, mode="r|gz") as bundle:
        for member in bundle:
            count += 1
            total += max(member.size, 0)
            if count > MAX_MEMBERS or total > MAX_EXPANDED_ARCHIVE or member.size < 0:
                raise GatewayError("source archive exceeds member or expanded-size limits")
            if member.name != "infra/linux/deploy-mes-release.sh":
                continue
            if contents is not None or not member.isreg() or member.size > 1024 * 1024:
                raise GatewayError("archive must contain one regular deploy-mes-release.sh under its size limit")
            source = bundle.extractfile(member)
            if source is None:
                raise GatewayError("deployment helper could not be read")
            contents = source.read(1024 * 1024 + 1)
            if len(contents) != member.size or len(contents) > 1024 * 1024:
                raise GatewayError("deployment helper size did not match the archive metadata")
    if contents is None:
        raise GatewayError("archive is missing deploy-mes-release.sh")
    fd, path = tempfile.mkstemp(prefix="mes-deploy-helper-", suffix=".sh", dir=INBOX)
    os.fchmod(fd, 0o555)
    with os.fdopen(fd, "wb") as output:
        output.write(contents)
    return Path(path)


def deploy(sha, expected):
    if not SHA_RE.fullmatch(sha) or not DIGEST_RE.fullmatch(expected):
        raise GatewayError("invalid commit or archive digest")
    assert_host_boundary()
    assert_rootless()
    lock_fd = open_deploy_lock()
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        os.close(lock_fd)
        raise GatewayError("another MES deployment request is active") from exc
    assert_root_inbox()
    fd, archive_name = tempfile.mkstemp(prefix=f"{sha}-", suffix=".tgz", dir=INBOX)
    runtime_account = pwd.getpwnam("mes-runtime")
    os.fchown(fd, 0, runtime_account.pw_gid)
    os.fchmod(fd, 0o640)
    digest = hashlib.sha256()
    size = 0
    helper = None
    try:
        with os.fdopen(fd, "wb") as archive:
            while True:
                block = sys.stdin.buffer.read(1024 * 1024)
                if not block:
                    break
                size += len(block)
                if size > MAX_ARCHIVE:
                    raise GatewayError("uploaded archive exceeds the size limit")
                digest.update(block)
                archive.write(block)
        if digest.hexdigest() != expected:
            raise GatewayError("uploaded archive digest mismatch")
        helper = extract_deploy_script(archive_name)
        # Transfer ownership through the runtime's own process.  The gateway
        # never traverses or mutates runtime-owned ancestry for this handoff.
        delivered = STAGING / f"{sha}-{expected}.tgz"
        runtime("/usr/bin/install", "-m", "0600", "--", archive_name, str(delivered))
        Path(archive_name).unlink()
        archive_name = None
        assert_rootless()
        account, env = runtime_context()
        env.update({
            "MES_DEPLOY_ROOT": str(ROOT),
            "MES_DEPLOY_PROJECT": PROJECT,
            "MES_DEPLOY_DATA_VOLUME": VOLUME,
            "MES_DEPLOY_PORT": PORT,
            "MES_REQUIRE_ROOTLESS_DOCKER": "1",
        })
        subprocess.run(
            ["/usr/sbin/runuser", "-u", account.pw_name, "--", "/usr/bin/env", *[f"{k}={v}" for k, v in env.items()], "/bin/bash", str(helper), sha, expected, str(delivered)],
            check=True,
        )
    finally:
        if archive_name is not None and Path(archive_name).parent == INBOX:
            Path(archive_name).unlink(missing_ok=True)
        if helper is not None:
            helper.unlink(missing_ok=True)
        os.close(lock_fd)


def main():
    if len(sys.argv) != 2:
        raise GatewayError("expected the original SSH command as one argument")
    command = sys.argv[1].split()
    if command == ["status"]:
        check_status()
    elif len(command) == 3 and command[0] == "deploy":
        deploy(command[1], command[2])
    else:
        raise GatewayError("unsupported SSH command")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"MES deployment gateway rejected request: {exc}", file=sys.stderr)
        raise SystemExit(1)
