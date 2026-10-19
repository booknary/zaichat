"""ZaiChat local ONNX embedding worker using an NDJSON stdio protocol."""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path
from typing import Any


DEVELOPMENT_DEPS = os.environ.get("ZAICHAT_WORKER_DEPS")
if DEVELOPMENT_DEPS:
    sys.path.insert(0, DEVELOPMENT_DEPS)

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


PROTOCOL_VERSION = 1
RUNTIME_VERSION = "0.8.0-worker.1"
MAX_BATCH_SIZE = 32
MAX_TEXT_CHARS = 50_000
MAX_LINE_CHARS = 4 * 1024 * 1024
MAX_TOKENS = 512


class ProtocolError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class EmbeddingEngine:
    def __init__(self) -> None:
        self.session: ort.InferenceSession | None = None
        self.tokenizer: Tokenizer | None = None
        self.model: dict[str, Any] | None = None

    def load(self, model_directory: Path, expected: dict[str, Any]) -> None:
        root = model_directory.resolve(strict=True)
        manifest_path = root / "manifest.json"
        if not manifest_path.is_file():
            raise ProtocolError("model-manifest-missing", "Model manifest is missing")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        model = manifest.get("model")
        if not isinstance(model, dict):
            raise ProtocolError("model-manifest-invalid", "Model fingerprint is missing")
        expected_fields = {
            "modelID": str(expected.get("id", "")),
            "version": str(expected.get("version", "")),
            "dimensions": int(expected.get("dimensions", 0)),
            "fingerprint": str(expected.get("fingerprint", "")),
        }
        for field, value in expected_fields.items():
            if model.get(field) != value:
                raise ProtocolError(
                    "model-fingerprint-mismatch", f"Model {field} does not match"
                )
        files = manifest.get("files")
        if not isinstance(files, list):
            raise ProtocolError("model-manifest-invalid", "Model file list is missing")
        onnx_files = [
            resolve_inside(root, str(entry.get("relativePath", "")))
            for entry in files
            if isinstance(entry, dict)
            and str(entry.get("relativePath", "")).lower().endswith(".onnx")
        ]
        if len(onnx_files) != 1 or not onnx_files[0].is_file():
            raise ProtocolError(
                "model-artifact-invalid", "Exactly one ONNX encoder is required"
            )
        tokenizer_path = root / "tokenizer.json"
        if not tokenizer_path.is_file():
            raise ProtocolError("tokenizer-missing", "tokenizer.json is missing")

        tokenizer = Tokenizer.from_file(str(tokenizer_path))
        tokenizer.enable_truncation(max_length=MAX_TOKENS)
        tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, min(8, os.cpu_count() or 1))
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(
            str(onnx_files[0]),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
        self.tokenizer = tokenizer
        self.session = session
        self.model = model
        try:
            self._self_test(expected_fields["dimensions"])
        except Exception:
            self.tokenizer = None
            self.session = None
            self.model = None
            raise

    def embed(self, texts: list[str], prefix: str) -> list[list[float]]:
        if self.session is None or self.tokenizer is None or self.model is None:
            raise ProtocolError("model-not-loaded", "Embedding model is not loaded")
        if not texts or len(texts) > MAX_BATCH_SIZE:
            raise ProtocolError(
                "invalid-batch", f"Embedding batch must contain 1-{MAX_BATCH_SIZE} texts"
            )
        prepared: list[str] = []
        for text in texts:
            if not isinstance(text, str) or not text.strip():
                raise ProtocolError("invalid-text", "Embedding text must not be empty")
            if len(text) > MAX_TEXT_CHARS:
                raise ProtocolError("text-too-long", "Embedding text exceeds its limit")
            normalized = text.strip()
            if not normalized.lower().startswith(prefix):
                normalized = f"{prefix} {normalized}"
            prepared.append(normalized)

        encodings = self.tokenizer.encode_batch(prepared)
        input_ids = np.asarray([value.ids for value in encodings], dtype=np.int64)
        attention_mask = np.asarray(
            [value.attention_mask for value in encodings], dtype=np.int64
        )
        available = {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
            "token_type_ids": np.zeros_like(input_ids),
        }
        session_inputs: dict[str, np.ndarray] = {}
        for metadata in self.session.get_inputs():
            if metadata.name not in available:
                raise ProtocolError(
                    "unsupported-model-input", f"Unsupported ONNX input: {metadata.name}"
                )
            session_inputs[metadata.name] = available[metadata.name]
        outputs = self.session.run(None, session_inputs)
        if not outputs or np.asarray(outputs[0]).ndim != 3:
            raise ProtocolError(
                "invalid-model-output", "ONNX encoder did not return token embeddings"
            )
        hidden = np.asarray(outputs[0], dtype=np.float32)
        mask = np.expand_dims(attention_mask.astype(np.float32), axis=-1)
        pooled = np.sum(hidden * mask, axis=1) / np.maximum(
            np.sum(mask, axis=1), np.float32(1.0)
        )
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        normalized = pooled / np.maximum(norms, np.float32(1e-12))
        dimensions = int(self.model["dimensions"])
        if normalized.shape != (len(texts), dimensions):
            raise ProtocolError(
                "dimension-mismatch", "Embedding output dimensions do not match"
            )
        if not np.isfinite(normalized).all():
            raise ProtocolError("non-finite-vector", "Embedding output is not finite")
        return normalized.astype(np.float32).tolist()

    def status(self) -> dict[str, Any]:
        return {
            "loaded": self.model is not None,
            "model": None
            if self.model is None
            else {
                "modelID": self.model.get("modelID"),
                "version": self.model.get("version"),
                "dimensions": self.model.get("dimensions"),
                "fingerprint": self.model.get("fingerprint"),
            },
        }

    def _self_test(self, dimensions: int) -> None:
        vector = np.asarray(self.embed(["ZaiChat runtime self test"], "query:"))[0]
        norm = float(np.linalg.norm(vector))
        if vector.shape != (dimensions,) or not math.isfinite(norm):
            raise ProtocolError("model-self-test-failed", "Model self-test failed")
        if not 0.999 <= norm <= 1.001:
            raise ProtocolError("model-self-test-failed", "Model output is not normalized")


class Worker:
    def __init__(self) -> None:
        self.engine = EmbeddingEngine()

    def handle(self, message: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        request_id = message.get("id")
        if not isinstance(request_id, str) or not request_id:
            raise ProtocolError("invalid-request-id", "Request ID is required")
        command = message.get("command")
        if command == "hello":
            return (
                {
                    "id": request_id,
                    "ok": True,
                    "protocolVersion": PROTOCOL_VERSION,
                    "runtimeVersion": RUNTIME_VERSION,
                    "pid": os.getpid(),
                },
                True,
            )
        if command == "ping":
            return {"id": request_id, "ok": True}, True
        if command == "load_model":
            directory = message.get("modelDirectory")
            expected = message.get("model")
            if not isinstance(directory, str) or not isinstance(expected, dict):
                raise ProtocolError("invalid-load-model", "Model arguments are invalid")
            self.engine.load(Path(directory), expected)
            return {"id": request_id, "ok": True, **self.engine.status()}, True
        if command in {"embed_query", "embed_documents"}:
            texts = message.get("texts")
            if not isinstance(texts, list):
                raise ProtocolError("invalid-batch", "Embedding texts must be an array")
            prefix = "query:" if command == "embed_query" else "passage:"
            return {
                "id": request_id,
                "ok": True,
                "vectors": self.engine.embed(texts, prefix),
            }, True
        if command == "get_status":
            return {"id": request_id, "ok": True, **self.engine.status()}, True
        if command == "shutdown":
            return {"id": request_id, "ok": True}, False
        raise ProtocolError("unknown-command", f"Unsupported command: {command}")


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def resolve_inside(root: Path, relative_path: str) -> Path:
    if not relative_path or Path(relative_path).is_absolute():
        raise ProtocolError("model-artifact-invalid", "Model artifact path is invalid")
    candidate = (root / relative_path).resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ProtocolError(
            "model-artifact-invalid", "Model artifact escaped its package"
        ) from error
    return candidate


def main() -> int:
    worker = Worker()
    for raw_line in sys.stdin:
        request_id: str | None = None
        try:
            if len(raw_line) > MAX_LINE_CHARS:
                raise ProtocolError("request-too-large", "NDJSON request is too large")
            message = json.loads(raw_line)
            if not isinstance(message, dict):
                raise ProtocolError("invalid-message", "NDJSON message must be an object")
            request_id = message.get("id") if isinstance(message.get("id"), str) else None
            response, keep_running = worker.handle(message)
            emit(response)
            if not keep_running:
                return 0
        except ProtocolError as error:
            emit(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"code": error.code, "message": str(error)},
                }
            )
        except Exception as error:
            print(f"worker-internal-error: {type(error).__name__}", file=sys.stderr)
            emit(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": "internal-error",
                        "message": "Embedding worker operation failed",
                    },
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
