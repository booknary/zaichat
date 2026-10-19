from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from zaichat_embedding_worker import EmbeddingEngine
from zaichat_embedding_worker import ProtocolError
from zaichat_embedding_worker import RUNTIME_VERSION
from zaichat_embedding_worker import Worker


class WorkerProtocolTest(unittest.TestCase):
    def test_real_stdio_ndjson_round_trip(self) -> None:
        worker_path = Path(__file__).with_name("zaichat_embedding_worker.py")
        process = subprocess.Popen(
            [sys.executable, str(worker_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        stdout, stderr = process.communicate(
            "\n".join(
                [
                    json.dumps({"id": "1", "command": "hello"}),
                    json.dumps({"id": "2", "command": "ping"}),
                    json.dumps({"id": "3", "command": "shutdown"}),
                ]
            )
            + "\n",
            timeout=10,
        )
        self.assertEqual(process.returncode, 0, stderr)
        messages = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual([value["id"] for value in messages], ["1", "2", "3"])
        self.assertTrue(all(value["ok"] for value in messages))

    def test_handshake_status_and_shutdown(self) -> None:
        worker = Worker()
        hello, keep_running = worker.handle({"id": "1", "command": "hello"})
        self.assertTrue(keep_running)
        self.assertEqual(hello["runtimeVersion"], RUNTIME_VERSION)
        status, keep_running = worker.handle(
            {"id": "2", "command": "get_status"}
        )
        self.assertTrue(keep_running)
        self.assertFalse(status["loaded"])
        shutdown, keep_running = worker.handle(
            {"id": "3", "command": "shutdown"}
        )
        self.assertTrue(shutdown["ok"])
        self.assertFalse(keep_running)

    def test_rejects_embedding_before_model_load(self) -> None:
        worker = Worker()
        with self.assertRaisesRegex(ProtocolError, "not loaded"):
            worker.handle(
                {"id": "1", "command": "embed_query", "texts": ["query"]}
            )

    def test_rejects_manifest_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            root = parent / "model"
            root.mkdir()
            (parent / "outside.onnx").write_bytes(b"outside")
            (root / "tokenizer.json").write_text("{}", encoding="utf-8")
            model = {
                "modelID": "model",
                "version": "1",
                "dimensions": 384,
                "fingerprint": "a" * 64,
            }
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "model": model,
                        "files": [{"relativePath": "../outside.onnx"}],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ProtocolError, "escaped"):
                EmbeddingEngine().load(
                    root,
                    {
                        "id": "model",
                        "version": "1",
                        "dimensions": 384,
                        "fingerprint": "a" * 64,
                    },
                )


if __name__ == "__main__":
    unittest.main()
