from pathlib import Path
import subprocess
import tempfile


workflow = Path(".github/workflows/mes.yml").read_text()
deploy = workflow.split("\n  deploy:\n", 1)[1]
script = Path("infra/linux/deploy-mes-release.sh").read_text()
docs = Path("docs/deployment/ISOLATED_DEPLOYMENT.md").read_text()
acceptance = Path("infra/linux/test-mes-deployment.sh").read_text()

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
    "checksum generated relative to artifact directory": "(cd deploy-artifact && sha256sum mes-source.tgz > mes-source.tgz.sha256)",
}
for label, value in required.items():
    if value not in deploy:
        raise SystemExit(f"Workflow deploy job is missing {label}: {value}")

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

# Exercise the exact artifact-relative checksum round trip used by the workflow.
with tempfile.TemporaryDirectory(prefix="mes-artifact-checksum-") as temporary:
    artifact_dir = Path(temporary) / "deploy-artifact"
    artifact_dir.mkdir()
    archive = artifact_dir / "mes-source.tgz"
    checksum = artifact_dir / "mes-source.tgz.sha256"
    archive.write_bytes(b"MES source archive checksum round-trip fixture\n")
    with checksum.open("wb") as output:
        subprocess.run(["sha256sum", "mes-source.tgz"], cwd=artifact_dir, check=True, stdout=output)
    subprocess.run(["sha256sum", "--check", "mes-source.tgz.sha256"], cwd=artifact_dir, check=True)

print("MES deployment workflow and isolation contract passed.")
