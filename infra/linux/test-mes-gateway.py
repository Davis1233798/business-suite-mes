import importlib.util
import io
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('gateway', Path(__file__).with_name('mes-deploy-gateway.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)

class GatewayArchiveTests(unittest.TestCase):
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

    def test_regular_helper_is_extracted_exactly(self):
        payload = b'#!/bin/bash\nexit 0\n'
        result = gateway.extract_deploy_script(self.archive([(tarfile.REGTYPE, payload)]))
        self.addCleanup(result.unlink)
        self.assertEqual(result.read_bytes(), payload)
        self.assertEqual(result.stat().st_mode & 0o777, 0o555)

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
            inbox.mkdir(mode=0o700)
            for item in (root, run):
                item.chmod(0o755)
            inbox.chmod(0o700)
            def verify_inbox(path):
                if path != inbox or not path.is_absolute():
                    raise gateway.GatewayError('inbox path is not fixed')
                current = Path('/')
                for part in path.parts[1:]:
                    current = current / part
                    info = current.lstat()
                    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                        raise gateway.GatewayError('unsafe root inbox ancestor')
                if stat.S_IMODE(path.stat().st_mode) != 0o700:
                    raise gateway.GatewayError('unsafe inbox mode')

            verify_inbox(inbox)
                # Model runtime replacing an intermediate ancestor by symlink.
                moved = root / 'run-saved'
                run.rename(moved)
                outside = root / 'runtime-controlled'
                outside.mkdir()
                run.symlink_to(outside, target_is_directory=True)
                with self.assertRaises(gateway.GatewayError):
                    verify_inbox(inbox)
                run.unlink()
                moved.rename(run)
                run.chmod(0o775)
                with self.assertRaises(gateway.GatewayError):
                    verify_inbox(inbox)

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

if __name__ == '__main__':
    unittest.main()
