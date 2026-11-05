import importlib.util
import hashlib
import io
import os
from pathlib import Path
import stat
import subprocess
import types
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location('gateway', Path(__file__).with_name('mes-deploy-gateway.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)

class GatewayArchiveTests(unittest.TestCase):
    def test_health_requires_running_image_revision(self):
        revision = 'a' * 40
        valid = {'success': True, 'data': {'backend': 'go', 'status': 'ready', 'revision': revision, 'uptime': 10}}
        self.assertEqual(gateway.validate_service_health(valid, 'business-suite-mes-station:' + revision), revision)
        invalid = [None, [], {'success': True}, {'success': 'true', 'data': valid['data']}]
        for data in ({'backend': 'go', 'status': 'ready'}, {**valid['data'], 'revision': 'b' * 40}, {**valid['data'], 'status': 'starting'}, {**valid['data'], 'backend': 'other'}):
            invalid.append({'success': True, 'data': data})
        for response in invalid:
            with self.subTest(response=response), self.assertRaises(gateway.GatewayError):
                gateway.validate_service_health(response, 'business-suite-mes-station:' + revision)
        for image in ('business-suite-mes-station:latest', 'other:' + revision, 'business-suite-mes-station:' + 'b' * 40):
            with self.subTest(image=image), self.assertRaises(gateway.GatewayError):
                gateway.validate_service_health(valid, image)

    def archive(self, entries):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        archive = Path(directory.name) / 'source.tgz'
        with tarfile.open(archive, 'w:gz') as bundle:
            for kind, payload in entries:
                member = tarfile.TarInfo('infra/linux/deploy-mes-release.sh')
                member.type = kind
                member.size = len(payload) if kind == tarfile.REGTYPE else 0
                bundle.addfile(member, io.BytesIO(payload) if member.size else None)
        return archive

    def test_command_parser_rejects_shell_and_path_arguments(self):
        commands = ['deploy ../escape bad', 'status; id', 'status extra', 'deploy ' + 'a'*40 + ' ' + 'b'*64 + ' extra', 'sh -c id']
        for command in commands:
            with self.subTest(command=command), mock.patch.object(gateway.sys, 'argv', ['gateway', command]), mock.patch.object(gateway, 'assert_host_boundary') as boundary:
                with self.assertRaises(gateway.GatewayError):
                    gateway.main()
                boundary.assert_not_called()

    def test_shared_oci_tree_requires_denied_runtime_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            shared = Path(temporary)
            accounts = [SimpleNamespace(pw_name='mes-deploy'), SimpleNamespace(pw_name='mes-runtime')]
            with mock.patch.object(gateway, 'SHARED_ROOT', shared), mock.patch.object(gateway.subprocess, 'run', return_value=SimpleNamespace(returncode=1)) as probe:
                gateway.assert_shared_tree_inaccessible(accounts)
                self.assertEqual(probe.call_count, 4)
            with mock.patch.object(gateway, 'SHARED_ROOT', shared), mock.patch.object(gateway.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
                with self.assertRaises(gateway.GatewayError):
                    gateway.assert_shared_tree_inaccessible(accounts)
            with mock.patch.object(gateway, 'SHARED_ROOT', shared), mock.patch.object(gateway.subprocess, 'run', return_value=SimpleNamespace(returncode=2)):
                with self.assertRaises(gateway.GatewayError):
                    gateway.assert_shared_tree_inaccessible(accounts)

    def test_shared_oci_tree_may_be_absent(self):
        with tempfile.TemporaryDirectory() as temporary:
            shared = Path(temporary) / 'not-created'
            accounts = [SimpleNamespace(pw_name='mes-deploy'), SimpleNamespace(pw_name='mes-runtime')]
            with mock.patch.object(gateway, 'SHARED_ROOT', shared), mock.patch.object(gateway.subprocess, 'run') as probe:
                gateway.assert_shared_tree_inaccessible(accounts)
                probe.assert_not_called()

    def test_regular_helper_is_extracted_exactly(self):
        payload = b'#!/bin/bash\nexit 0\n'
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(gateway, 'INBOX', Path(temporary)):
            result = gateway.extract_deploy_script(self.archive([(tarfile.REGTYPE, payload)]))
            self.assertEqual(result.read_bytes(), payload)
            self.assertEqual(result.stat().st_mode & 0o777, 0o555)
            result.unlink()

    def test_duplicate_or_link_helper_is_rejected(self):
        for entries in ([(tarfile.REGTYPE, b'a'), (tarfile.REGTYPE, b'b')], [(tarfile.SYMTYPE, b'')], []):
            with self.subTest(entries=entries), self.assertRaises(gateway.GatewayError):
                gateway.extract_deploy_script(self.archive(entries))

    def test_inbox_requires_root_controlled_ancestors_and_fixed_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / 'run'
            inbox = run / 'mes-deploy-inbox'
            run.mkdir(mode=0o755)
            inbox.mkdir(mode=0o710)
            for item in (root, run):
                item.chmod(0o755)
            inbox.chmod(0o710)
            gateway.validate_root_inbox(inbox, run, os.getuid(), os.getgid())
            moved = root / 'run-saved'
            run.rename(moved)
            outside = root / 'runtime-controlled'
            outside.mkdir()
            run.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(gateway.GatewayError):
                gateway.validate_root_inbox(inbox, run, os.getuid(), os.getgid())
            run.unlink()
            moved.rename(run)
            run.chmod(0o775)
            with self.assertRaises(gateway.GatewayError):
                gateway.validate_root_inbox(inbox, run, os.getuid(), os.getgid())

    def test_gateway_lock_rejects_preplaced_symlink_and_wrong_owner(self):
        with tempfile.TemporaryDirectory() as temporary:
            inbox = Path(temporary) / 'mes-deploy-inbox'
            inbox.mkdir(mode=0o710)
            lock = inbox / 'gateway.lock'
            target = Path(temporary) / 'outside'
            target.write_text('outside')
            lock.symlink_to(target)
            with mock.patch.object(gateway, 'INBOX', inbox), self.assertRaises(OSError):
                gateway.open_deploy_lock()

            lock.unlink()
            fd, _ = tempfile.mkstemp(dir=inbox)
            os.close(fd)
            try:
                fake_stat = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=os.getuid() + 1)
                with mock.patch.object(gateway, 'INBOX', inbox), mock.patch.object(gateway.os, 'fstat', return_value=fake_stat), self.assertRaises(gateway.GatewayError):
                    gateway.open_deploy_lock()
                bad_mode = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o640, st_uid=0)
                with mock.patch.object(gateway, 'INBOX', inbox), mock.patch.object(gateway.os, 'fstat', return_value=bad_mode), self.assertRaises(gateway.GatewayError):
                    gateway.open_deploy_lock()
            finally:
                (inbox / 'gateway.lock').unlink(missing_ok=True)

    def test_cleanup_scope_never_unlinks_runtime_staging_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inbox = root / 'inbox'
            runtime_root = root / 'runtime-root'
            staging = runtime_root / 'staging'
            inbox.mkdir()
            staging.mkdir(parents=True)
            archive = staging / 'runtime-owned.tgz'
            archive.write_bytes(b'keep')
            root_archive = inbox / 'gateway-upload.tgz'
            root_archive.write_bytes(b'delete')
            # Exercise the same parent guard used by gateway finally cleanup.
            for candidate in (root_archive, archive):
                if candidate.parent == inbox:
                    candidate.unlink(missing_ok=True)
            self.assertFalse(root_archive.exists())
            self.assertEqual(archive.read_bytes(), b'keep')

    def test_archive_validation_precedes_runtime_staging_handoff(self):
        source = Path(__file__).with_name('mes-deploy-gateway.py').read_text()
        extraction = source.index('helper = extract_deploy_script(archive_name)')
        delivery = source.index('runtime("/usr/bin/install", "-m", "0600", "--", archive_name, str(delivered))')
        self.assertLess(extraction, delivery)
        self.assertNotIn('extract_deploy_script(delivered)', source)

    def make_upload(self):
        output = io.BytesIO()
        payload = b'#!/bin/bash\nexit 0\n'
        with tarfile.open(fileobj=output, mode='w:gz') as bundle:
            member = tarfile.TarInfo('infra/linux/deploy-mes-release.sh')
            member.size = len(payload)
            bundle.addfile(member, io.BytesIO(payload))
        data = output.getvalue()
        return data, hashlib.sha256(data).hexdigest()

    def run_deploy_fixture(self, data, expected, fail_install=False, fail_deploy=False, expect_hash_error=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        anchor = root / 'run'
        inbox = anchor / 'mes-deploy-inbox'
        staging = root / 'runtime' / 'staging'
        anchor.mkdir(mode=0o755)
        inbox.mkdir(mode=0o710)
        staging.mkdir(parents=True)
        anchor.chmod(0o755)
        inbox.chmod(0o710)
        lock_fd, _ = tempfile.mkstemp(dir=root)
        original_mkstemp = tempfile.mkstemp
        original_open = os.open
        handoffs = []

        def fixture_mkstemp(*args, **kwargs):
            kwargs['dir'] = inbox
            return original_mkstemp(*args, **kwargs)

        def fake_runtime(*args, **kwargs):
            self.assertEqual(args[0], '/usr/bin/install')
            source = Path(args[-2])
            destination = Path(args[-1])
            self.assertEqual(source.parent, inbox)
            self.assertTrue(any(path.name.startswith('mes-deploy-helper-') for path in inbox.iterdir()))
            handoffs.append((source, destination))
            if fail_install:
                raise OSError('simulated runtime install failure')
            destination.write_bytes(source.read_bytes())
            return types.SimpleNamespace(returncode=0)

        def fixture_open(path, *args, **kwargs):
            if str(path) == str(inbox / 'gateway.lock'):
                return lock_fd
            return original_open(path, *args, **kwargs)

        def fake_run(*args, **kwargs):
            if fail_deploy:
                raise subprocess.CalledProcessError(1, args[0])
            return subprocess.CompletedProcess([], 0)

        account = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid(), pw_name='mes-runtime')
        fchown = mock.Mock()
        stdin = types.SimpleNamespace(buffer=io.BytesIO(data))
        patches = [
            mock.patch.object(gateway, 'INBOX', inbox),
            mock.patch.object(gateway, 'STAGING', staging),
            mock.patch.object(gateway, 'assert_root_inbox', side_effect=lambda: gateway.validate_root_inbox(inbox, anchor, os.getuid(), os.getgid())),
            mock.patch.object(gateway, 'assert_host_boundary'),
            mock.patch.object(gateway, 'assert_rootless'),
            mock.patch.object(gateway, 'runtime', side_effect=fake_runtime),
            mock.patch.object(gateway, 'runtime_context', return_value=(account, {})),
            mock.patch.object(gateway.pwd, 'getpwnam', return_value=account),
            mock.patch.object(gateway.os, 'open', side_effect=fixture_open),
            mock.patch.object(gateway.os, 'fstat', return_value=types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)),
            mock.patch.object(gateway.os, 'fchown', side_effect=fchown),
            mock.patch.object(gateway.os, 'fchmod'),
            mock.patch.object(gateway.fcntl, 'flock'),
            mock.patch.object(gateway.subprocess, 'run', side_effect=fake_run),
            mock.patch.object(gateway.sys, 'stdin', stdin),
            mock.patch.object(gateway.tempfile, 'mkstemp', side_effect=fixture_mkstemp),
        ]
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8], patches[9], patches[10], patches[11], patches[12], patches[13], patches[14]:
            if fail_install:
                with self.assertRaises(OSError):
                    gateway.deploy('a' * 40, expected)
            elif fail_deploy:
                with self.assertRaises(subprocess.CalledProcessError):
                    gateway.deploy('a' * 40, expected)
            elif expect_hash_error:
                with self.assertRaisesRegex(gateway.GatewayError, 'digest mismatch'):
                    gateway.deploy('a' * 40, expected)
            else:
                gateway.deploy('a' * 40, expected)
        self.assertEqual(fchown.call_args.args[1:], (0, os.getgid()))
        return inbox, staging, handoffs

    def test_deploy_hash_mismatch_cleans_only_root_inbox_without_handoff(self):
        data, digest = self.make_upload()
        inbox, staging, handoffs = self.run_deploy_fixture(data, '0' * 64, expect_hash_error=True)
        self.assertEqual(list(inbox.iterdir()), [])
        self.assertEqual(list(staging.iterdir()), [])
        self.assertEqual(handoffs, [])

    def test_deploy_runtime_install_failure_cleans_root_temps_only(self):
        data, digest = self.make_upload()
        inbox, staging, handoffs = self.run_deploy_fixture(data, digest, fail_install=True)
        self.assertEqual(list(inbox.iterdir()), [])
        self.assertEqual(list(staging.iterdir()), [])
        self.assertEqual(len(handoffs), 1)

    def test_deploy_success_keeps_delivered_archive_in_runtime_staging(self):
        data, digest = self.make_upload()
        inbox, staging, handoffs = self.run_deploy_fixture(data, digest)
        self.assertEqual(list(inbox.iterdir()), [])
        delivered = list(staging.iterdir())
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0].read_bytes(), data)
        self.assertEqual(handoffs[0][1], delivered[0])

    def test_deploy_failure_cleans_helper_but_not_runtime_archive(self):
        data, digest = self.make_upload()
        inbox, staging, handoffs = self.run_deploy_fixture(data, digest, fail_deploy=True)
        self.assertEqual(list(inbox.iterdir()), [])
        self.assertEqual(len(list(staging.iterdir())), 1)
        self.assertEqual(handoffs[0][1].read_bytes(), data)

if __name__ == '__main__':
    unittest.main()
