"""Reject failed, foreign, ambiguous, expired, or unverifiable build artifacts."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('mas_download', Path(__file__).with_name('download-mas-release.py'))
download = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download)


class BuildArtifactTests(unittest.TestCase):
    def setUp(self):
        self.repo = 'owner/app'
        self.run = dict(status='completed', conclusion='success',
                        path='.github/workflows/build-mas.yml', run_number=13,
                        head_repository=dict(full_name=self.repo))
        self.artifact = dict(name='Lingxi-Workspace-MAS-1.0.14-13', expired=False,
                             digest='sha256:' + 'a' * 64)

    def test_successful_build(self):
        self.assertEqual(download.select_artifact(self.run, [self.artifact], self.repo), self.artifact)

    def test_wrong_source_or_failed_run(self):
        for change in [dict(conclusion='failure'), dict(status='in_progress'),
                       dict(path='.github/workflows/other.yml'),
                       dict(head_repository=dict(full_name='fork/app'))]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                download.select_artifact(dict(self.run, **change), [self.artifact], self.repo)

    def test_missing_or_ambiguous_artifacts(self):
        for artifacts in [[], [self.artifact, self.artifact]]:
            with self.subTest(artifacts=artifacts), self.assertRaises(ValueError):
                download.select_artifact(self.run, artifacts, self.repo)

    def test_expired_digest_or_wrong_run(self):
        for change in [dict(expired=True), dict(digest=None), dict(digest='sha256:invalid'),
                       dict(name='Lingxi-Workspace-MAS-1.0.14-12')]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                download.select_artifact(self.run, [dict(self.artifact, **change)], self.repo)


if __name__ == '__main__':
    unittest.main()
