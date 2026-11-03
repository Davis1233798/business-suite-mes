import importlib.util
import io
from pathlib import Path
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

if __name__ == '__main__':
    unittest.main()
