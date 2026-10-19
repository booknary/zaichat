from __future__ import annotations

import argparse
import json
import tempfile
import unittest
from pathlib import Path

from generate_artifact_manifest import generate
from generate_artifact_manifest import verify


class ArtifactManifestTest(unittest.TestCase):
    def test_generate_verify_and_detect_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "bin" / "worker.exe"
            executable.parent.mkdir()
            executable.write_bytes(b"worker")
            manifest_path = root / "manifest.json"
            result = generate(
                argparse.Namespace(
                    root=root,
                    output=manifest_path,
                    package_type="runtime",
                    package_id="zaichat/worker",
                    version="1",
                    url_base="https://downloads.example.invalid/runtime",
                    executable="bin/worker.exe",
                    model_fingerprint=None,
                )
            )
            self.assertEqual(result, 0)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(len(manifest["files"]), 1)
            self.assertTrue(manifest["files"][0]["executable"])
            self.assertEqual(
                verify(argparse.Namespace(root=root, manifest=manifest_path)), 0
            )
            executable.write_bytes(b"damaged")
            with self.assertRaisesRegex(ValueError, "Size mismatch"):
                verify(argparse.Namespace(root=root, manifest=manifest_path))

    def test_rejects_non_https_release_urls(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "worker.exe").write_bytes(b"worker")
            with self.assertRaisesRegex(ValueError, "HTTPS"):
                generate(
                    argparse.Namespace(
                        root=root,
                        output=root / "manifest.json",
                        package_type="runtime",
                        package_id="worker",
                        version="1",
                        url_base="http://example.invalid",
                        executable="worker.exe",
                        model_fingerprint=None,
                    )
                )


if __name__ == "__main__":
    unittest.main()
