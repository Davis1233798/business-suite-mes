from pathlib import Path
import subprocess
import tempfile


workflow = Path(".github/workflows/mes.yml").read_text()
windows_desktop = workflow.split("\n  windows-desktop:\n", 1)[1].split("\n  mes:\n", 1)[0]
mes = workflow.split("\n  mes:\n", 1)[1].split("\n  release:\n", 1)[0]
release = workflow.split("\n  release:\n", 1)[1].split("\n  deploy:\n", 1)[0]
deploy = workflow.split("\n  deploy:\n", 1)[1]
script = Path("infra/linux/deploy-mes-release.sh").read_text()
docs = Path("docs/deployment/ISOLATED_DEPLOYMENT.md").read_text()
acceptance = Path("infra/linux/test-mes-deployment.sh").read_text()

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
    "unique archive upload": "${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.tgz",
    "uploaded deployment script": "deploy-mes-release.sh",
    "remote script checksum verification": "sha256sum --check --status",
    "script file execution": "bash '$remote_script'",
    "closed script stdin": "</dev/null",
    "fixed production root": "MES_DEPLOY_ROOT=/srv/business-suite-mes",
    "fixed MES project": "MES_DEPLOY_PROJECT=business-suite-mes",
    "fixed MES volume": "MES_DEPLOY_DATA_VOLUME=business-suite-mes-station-data",
    "fixed loopback port": "MES_DEPLOY_PORT=18095",
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

for forbidden in ("OCI_DEPLOY_KEY", "/srv/business-suite/current", "business-suite-station-data", "ssh-keyscan"):
    if forbidden in deploy:
        raise SystemExit(f"Workflow deploy job references forbidden shared deployment setting: {forbidden}")

if "bash -s" in deploy or "< infra/linux/deploy-mes-release.sh" in deploy:
    raise SystemExit("Deployment script must be uploaded, checksum-verified, and executed as a file with stdin closed")

for value in ("business-suite-mes/v1", "business-suite-mes-station-data", "MES_DEPLOY_ENABLED=true", "mes-production"):
    if value not in docs:
        raise SystemExit(f"Deployment boundary documentation is missing: {value}")

for value in ("Production project, data volume, and port are fixed", "unexpected service", "Test roots require unique test-only"):
    if value not in script:
        raise SystemExit(f"Deployment script is missing boundary enforcement: {value}")

for value in ("compose_volume_matches", "A missed volume substitution passed the compose isolation guard", "Refusing cleanup of non-test volume", "Refusing cleanup: test project or effective volume"):
    if value not in acceptance:
        raise SystemExit(f"Remote acceptance is missing test-volume safety coverage: {value}")


print("MES deployment workflow and isolation contract passed.")
