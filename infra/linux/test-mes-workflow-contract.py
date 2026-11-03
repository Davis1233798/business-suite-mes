from pathlib import Path
import subprocess
import tempfile


workflow = Path(".github/workflows/mes.yml").read_text()
windows_desktop = workflow.split("\n  windows-desktop:\n", 1)[1].split("\n  mes:\n", 1)[0]
mes = workflow.split("\n  mes:\n", 1)[1].split("\n  release:\n", 1)[0]
release = workflow.split("\n  release:\n", 1)[1].split("\n  deploy:\n", 1)[0]
deploy = workflow.split("\n  deploy:\n", 1)[1]
script = Path("infra/linux/deploy-mes-release.sh").read_text()
gateway = Path("infra/linux/mes-deploy-gateway.py").read_text()
docs = Path("docs/deployment/ISOLATED_DEPLOYMENT.md").read_text()
acceptance = Path("infra/linux/test-mes-deployment.sh").read_text()
host_audit = Path("infra/linux/test-mes-host-isolation.sh").read_text()
ssh_policy = Path("infra/linux/sshd-mes-deploy.conf").read_text()
sudo_policy = Path("infra/linux/mes-deploy.sudoers").read_text()
compose = Path("infra/linux/compose.mes-isolated.yaml").read_text()

# Execute the workflow's checksum path convention against a downloaded artifact layout.
with tempfile.TemporaryDirectory(prefix="mes-artifact-checksum-") as temporary:
    root = Path(temporary)
    artifact_dir = root / "deploy-artifact"
    artifact_dir.mkdir()
    (artifact_dir / "mes-source.tgz").write_bytes(b"MES source archive checksum round-trip fixture\n")
    if "(cd deploy-artifact && sha256sum mes-source.tgz > mes-source.tgz.sha256)" in workflow:
        checksum_command = ["sha256sum", "mes-source.tgz"]
        checksum_cwd = artifact_dir
    elif "sha256sum deploy-artifact/mes-source.tgz > deploy-artifact/mes-source.tgz.sha256" in workflow:
        checksum_command = ["sha256sum", "deploy-artifact/mes-source.tgz"]
        checksum_cwd = root
    else:
        raise SystemExit("Workflow checksum generation command is not covered by the artifact round-trip test")
    with (artifact_dir / "mes-source.tgz.sha256").open("wb") as output:
        subprocess.run(checksum_command, cwd=checksum_cwd, check=True, stdout=output)
    verification = subprocess.run(
        ["sha256sum", "--check", "mes-source.tgz.sha256"],
        cwd=artifact_dir,
        capture_output=True,
        text=True,
    )
    if verification.returncode:
        raise SystemExit(f"Artifact checksum does not survive upload/download layout: {verification.stderr.strip()}")

required = {
    "main-only deployment": "github.ref == 'refs/heads/main'",
    "explicit opt-in": "vars.MES_DEPLOY_ENABLED == 'true'",
    "protected environment": "environment: mes-production",
    "dedicated SSH key": "secrets.MES_DEPLOY_KEY",
    "pinned SSH host key": "secrets.MES_DEPLOY_HOST_KEY",
    "strict host checking": "StrictHostKeyChecking yes",
    "status request through forced command": "mes-production status",
    "deploy request through forced command": '"deploy $GITHUB_SHA $digest"',
    "archive delivered over stdin": "< deploy-artifact/mes-source.tgz",
    "fixed gateway status step": "fixed remote deployment gateway",
}
for label, value in required.items():
    if value not in deploy:
        raise SystemExit(f"Workflow deploy job is missing {label}: {value}")

if "(cd deploy-artifact && sha256sum mes-source.tgz > mes-source.tgz.sha256)" not in workflow:
    raise SystemExit("Workflow must create the artifact checksum relative to its upload directory")

if "needs: mes" not in windows_desktop:
    raise SystemExit("Windows packaging must wait for MES validation before uploading its desktop artifact")
windows_steps = ["node --test tests/desktop-identity.test.cjs", "npm run desktop:prepare", "npm run desktop:package", "actions/upload-artifact@v4"]
windows_positions = [windows_desktop.find(step) for step in windows_steps]
if any(position < 0 for position in windows_positions) or windows_positions != sorted(windows_positions):
    raise SystemExit("Windows identity checks and packaging must pass before uploading its desktop artifact")
if "needs: [mes, windows-desktop]" not in release:
    raise SystemExit("Release artifacts and image publication must wait for MES and Windows desktop validation")
if "if: github.event_name == 'push' && github.ref == 'refs/heads/main'" not in release:
    raise SystemExit("Release artifacts and image publication must be main-push only")
if "Package exact main source for deployment" not in release or "actions/upload-artifact@v4" not in release:
    raise SystemExit("Main source artifact must be created and uploaded in the gated release job")
if "Publish MES image after all platform builds" not in release or "docker push \"$image:${GITHUB_SHA}\"" not in release:
    raise SystemExit("MES image publication must be gated on both platform validation jobs")
if "if: always()" in release or "if: always()" in windows_desktop:
    raise SystemExit("Release and Windows build artifacts must not be uploaded after failed dependencies or steps")
if "actions/upload-artifact@v4" in mes:
    raise SystemExit("Deployable source artifacts must not be uploaded by the ungated MES validation job")
if "needs: [mes, windows-desktop, release]" not in deploy:
    raise SystemExit("Deployment must depend on MES, Windows desktop, and the gated release artifact")

for forbidden in ("OCI_DEPLOY_KEY", "/srv/business-suite/current", "business-suite-station-data", "ssh-keyscan", "scp ", "remote_script", "bash '$remote_script'"):
    if forbidden in deploy:
        raise SystemExit(f"Workflow deploy job references forbidden shared deployment setting: {forbidden}")

if "SSH_ORIGINAL_COMMAND" not in ssh_policy or 'pwd.getpwnam("mes-runtime")' not in gateway or "/usr/sbin/runuser" not in gateway:
    raise SystemExit("Forced-command gateway must validate SSH commands and run deployment as mes-runtime")
if "docker info" not in gateway or "rootless" not in gateway:
    raise SystemExit("Forced-command gateway must require the mes-runtime rootless Docker daemon")
if '"$root" == /srv/business-suite-mes' not in script or "MES_REQUIRE_ROOTLESS_DOCKER" not in script or '"name=rootless"' not in script:
    raise SystemExit("Production deployment helper must reject rootful or non-mes-runtime Docker contexts")
for value in ("status", "deploy", "MAX_ARCHIVE", "sha256", "runuser", "127.0.0.1:18095", "business-suite-mes/v1"):
    if value not in gateway:
        raise SystemExit(f"Forced-command gateway is missing validation: {value}")
if "SSH_ORIGINAL_COMMAND" not in ssh_policy or "ForceCommand" not in ssh_policy or "DisableForwarding yes" not in ssh_policy or "AllowStreamLocalForwarding no" not in ssh_policy:
    raise SystemExit("SSH policy must route all MES deploy logins through the fixed gateway")
if "mes-deploy ALL=(root) NOPASSWD: /usr/local/sbin/mes-deploy-gateway" not in sudo_policy:
    raise SystemExit("Sudo policy must grant only the fixed root-owned gateway")
if "sudo -n docker" in deploy or "docker compose" in deploy:
    raise SystemExit("Workflow must not receive direct Docker permissions")
for value in ("127.0.0.1:${MES_DEPLOY_PORT:-18095}:8095", "mes-station-data"):
    if value not in compose:
        raise SystemExit(f"MES Compose contract is missing {value}")
for value in ("/var/run/docker.sock", "privileged: true", "network_mode: host"):
    if value in compose:
        raise SystemExit(f"MES Compose contract contains a forbidden host escape: {value}")

for value in ("business-suite-mes/v1", "business-suite-mes-station-data", "MES_DEPLOY_ENABLED=true", "mes-production", "rootless", "ForceCommand", "business-suite-mes_default", "跨主機", "mTLS", "不完成公開 hostname cutover"):
    if value not in docs:
        raise SystemExit(f"Deployment boundary documentation is missing: {value}")

for value in ("Production project, data volume, and port are fixed", "unexpected service", "Test roots require unique test-only"):
    if value not in script:
        raise SystemExit(f"Deployment script is missing boundary enforcement: {value}")

for value in ("compose_volume_matches", "A missed volume substitution passed the compose isolation guard", "Refusing cleanup of non-test volume", "Refusing cleanup: test project or effective volume"):
    if value not in acceptance:
        raise SystemExit(f"Remote acceptance is missing test-volume safety coverage: {value}")

for value in ("mes-deploy", "mes-runtime", "rootless", "/var/run/docker.sock", "ForceCommand", "business-suite"):
    if value not in host_audit:
        raise SystemExit(f"Remote host isolation audit is missing: {value}")


print("MES deployment workflow and isolation contract passed.")
