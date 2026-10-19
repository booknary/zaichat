from __future__ import annotations

import argparse
import json
import tempfile
import unittest
from pathlib import Path

from build_semantic_release import DESCRIPTOR_FILE
from build_semantic_release import MODEL_FILES
from build_semantic_release import finalize
from build_semantic_release import install_local
from build_semantic_release import stage
from build_semantic_release import verify


class SemanticReleaseBuilderTest(unittest.TestCase):
    def fixture(self, root: Path) -> tuple[Path, Path]:
        runtime = root / "worker.exe"
        runtime.write_bytes(b"worker")
        model = root / "model"
        for index, relative in enumerate(MODEL_FILES):
            path = model / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"model-{index}".encode())
        return runtime, model

    def stage_args(
        self, runtime: Path, model: Path, output: Path, replace: bool = False
    ) -> argparse.Namespace:
        return argparse.Namespace(
            runtime_executable=runtime,
            runtime_version="0.8.0-worker.1",
            runtime_package_id="zaichat/embedding-worker",
            model_root=model,
            model_id="intfloat/multilingual-e5-small",
            model_version="fixture-revision",
            model_package_id="intfloat/multilingual-e5-small",
            dimensions=384,
            output=output,
            replace=replace,
        )

    def test_stage_verify_and_finalize(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, model = self.fixture(root)
            output = root / "release"
            self.assertEqual(stage(self.stage_args(runtime, model, output)), 0)
            descriptor = json.loads(
                (output / DESCRIPTOR_FILE).read_text(encoding="utf-8")
            )
            self.assertEqual(descriptor["state"], "staged")
            self.assertNotIn("releaseBase", descriptor)
            self.assertEqual(
                verify(
                    argparse.Namespace(
                        root=output,
                        require_manifests=False,
                        allow_test_url=False,
                    )
                ),
                0,
            )
            self.assertEqual(
                finalize(
                    argparse.Namespace(
                        root=output,
                        url_base="https://release-fixture.invalid/v0.8.0",
                        allow_test_url=True,
                    )
                ),
                0,
            )
            self.assertEqual(
                verify(
                    argparse.Namespace(
                        root=output,
                        require_manifests=True,
                        allow_test_url=True,
                    )
                ),
                0,
            )
            manifest = json.loads(
                (output / "manifests" / "multilingual-e5-small.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertTrue(
                all(
                    file["url"].startswith("https://release-fixture.invalid/")
                    for file in manifest["files"]
                )
            )

    def test_rejects_placeholder_url_and_unmarked_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, model = self.fixture(root)
            output = root / "release"
            output.mkdir()
            (output / "user-file.txt").write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unmarked"):
                stage(self.stage_args(runtime, model, output, replace=True))
            output = root / "safe-release"
            self.assertEqual(stage(self.stage_args(runtime, model, output)), 0)
            with self.assertRaisesRegex(ValueError, "Placeholder"):
                finalize(
                    argparse.Namespace(
                        root=output,
                        url_base="https://downloads.example.invalid/v0.8.0",
                        allow_test_url=False,
                    )
                )

    def test_detects_tampered_asset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, model = self.fixture(root)
            output = root / "release"
            self.assertEqual(stage(self.stage_args(runtime, model, output)), 0)
            descriptor = json.loads(
                (output / DESCRIPTOR_FILE).read_text(encoding="utf-8")
            )
            asset = descriptor["packages"][0]["files"][0]["assetName"]
            (output / "assets" / asset).write_bytes(b"damaged")
            with self.assertRaisesRegex(ValueError, "size mismatch"):
                verify(
                    argparse.Namespace(
                        root=output,
                        require_manifests=False,
                        allow_test_url=False,
                    )
                )

    def test_installs_staged_assets_into_a_managed_local_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, model = self.fixture(root)
            output = root / "release"
            destination = root / "profile" / "semantic-artifacts"
            self.assertEqual(stage(self.stage_args(runtime, model, output)), 0)
            self.assertEqual(
                install_local(
                    argparse.Namespace(
                        root=output,
                        destination=destination,
                        installation_id="zaichat@booknary.github.io",
                        replace=False,
                    )
                ),
                0,
            )
            runtime_manifest = (
                destination
                / "runtime"
                / "zaichat%2Fembedding-worker"
                / "0.8.0-worker.1"
                / "manifest.json"
            )
            model_file = (
                destination
                / "model"
                / "intfloat%2Fmultilingual-e5-small"
                / "fixture-revision"
                / "onnx"
                / "model.onnx"
            )
            self.assertTrue(runtime_manifest.is_file())
            self.assertEqual(model_file.read_bytes(), b"model-0")
            manifest = json.loads(runtime_manifest.read_text(encoding="utf-8"))
            self.assertEqual(
                manifest["files"][0]["url"],
                "https://semantic-assets.zaichat.invalid/local-test/zaichat-embedding-worker-win-x64-0.8.0-worker.1.exe",
            )


if __name__ == "__main__":
    unittest.main()
