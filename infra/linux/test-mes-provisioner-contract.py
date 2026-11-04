from pathlib import Path
import re


provisioner = Path("infra/linux/provision-mes-rootless-host.sh").read_text()
workflow = Path(".github/workflows/mes.yml").read_text()
docs = Path("docs/deployment/MES_OCI_PROVISIONING.md").read_text()
vendor_manifest = Path("infra/linux/rootless-vendor/SOURCE.md")
vendor_license = Path("infra/linux/rootless-vendor/LICENSE")

for value in (
    "--check", "--apply", "/srv/business-suite", "/srv/business-suite-mes",
    "mes-runtime", "mes-deploy", "business-suite-mes/host-provisioner/v1",
    "business-suite-mes/v1", "subuid", "subgid", "setfacl", "rootless",
    "loginctl", "enable-linger", "/run/mes-deploy-inbox", "0710",
    "mes-deploy-gateway", "sshd -T", "sshd -t", "visudo -cf",
):
    if value not in provisioner:
        raise SystemExit(f"Host provisioner is missing required boundary: {value}")

for forbidden in (
    "docker-ce-rootless-extras", "systemctl stop docker", "systemctl disable docker",
    "docker system prune", "usermod -aG docker", "kernel.apparmor_restrict_unprivileged_userns=0",
    "kernel.unprivileged_userns_clone=1", "apparmor=0", "aa-disable",
):
    if forbidden in provisioner:
        raise SystemExit(f"Host provisioner contains a forbidden host-wide change: {forbidden}")

if not vendor_manifest.is_file() or not vendor_license.is_file():
    raise SystemExit("Pinned rootless scripts must include source/checksum metadata and license")
manifest = vendor_manifest.read_text()
for value in ("docker-v29.1.3", "SHA-256", "Apache-2.0", "dockerd-rootless.sh", "dockerd-rootless-setuptool.sh"):
    if value not in manifest:
        raise SystemExit(f"Rootless vendor manifest is missing {value}")

job_match = re.search(r"(?ms)^  rootless-host-provisioning:\n(.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)", workflow)
if not job_match:
    raise SystemExit("Workflow must contain a rootless-host-provisioning job")
job = job_match.group(1)
for value in (
    "runs-on: ubuntu-24.04-arm", "provision-mes-rootless-host.sh --check",
    "provision-mes-rootless-host.sh --apply", "test-mes-host-isolation.sh",
    "test-mes-deployment.sh", "mes-provisioner-rootful-sentinel",
):
    if value not in job:
        raise SystemExit(f"Disposable ARM64 acceptance job is missing {value}")
for value in ("needs: [mes, windows-desktop, rootless-host-provisioning]",):
    if value not in workflow:
        raise SystemExit(f"Release gates do not include rootless acceptance: {value}")

for value in ("--check", "--apply", "rootful", "AppArmor", "ubuntu-24.04-arm", "不會建立部署 SSH key"):
    if value not in docs:
        raise SystemExit(f"Provisioning documentation is missing {value}")

print("MES rootless host provisioning contract passed.")
