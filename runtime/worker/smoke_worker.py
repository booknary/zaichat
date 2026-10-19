"""Run the source worker against a local frozen model package."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import time
from pathlib import Path

from zaichat_embedding_worker import EmbeddingEngine


MODEL_ID = "intfloat/multilingual-e5-small"
MODEL_VERSION = "0e60b8d9d2166d80387f86e3b48ec9ced55f4d15"
DIMENSIONS = 384
FINGERPRINT = "c" * 64


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--executable", type=Path)
    args = parser.parse_args()
    root = args.model_root.resolve(strict=True)
    manifest_path = root / "manifest.json"
    created_manifest = not manifest_path.exists()
    if created_manifest:
        manifest_path.write_text(
            json.dumps(
                {
                    "formatVersion": 1,
                    "packageType": "model",
                    "packageID": MODEL_ID,
                    "version": MODEL_VERSION,
                    "platform": "win-x64",
                    "files": [{"relativePath": "onnx/model.onnx"}],
                    "model": {
                        "modelID": MODEL_ID,
                        "version": MODEL_VERSION,
                        "dimensions": DIMENSIONS,
                        "fingerprint": FINGERPRINT,
                    },
                }
            ),
            encoding="utf-8",
        )
    try:
        texts = [
            "帮我找一下，有一篇关于两次基因组创新的文章",
            "novel genomic changes that enabled the origin of land plants",
        ]
        if args.executable:
            load_ms, embed_ms, vectors = run_packaged(
                args.executable.resolve(strict=True), root, texts
            )
            runtime = "packaged-worker"
        else:
            engine = EmbeddingEngine()
            started = time.perf_counter()
            engine.load(root, expected_model())
            load_ms = (time.perf_counter() - started) * 1000
            started = time.perf_counter()
            vectors = engine.embed(texts, "query:")
            embed_ms = (time.perf_counter() - started) * 1000
            runtime = "source-worker"
        norms = [math.sqrt(sum(component * component for component in row)) for row in vectors]
        result = {
            "runtime": runtime,
            "dimensions": [len(row) for row in vectors],
            "norms": norms,
            "loadMs": load_ms,
            "batch2Ms": embed_ms,
            "passed": all(len(row) == DIMENSIONS for row in vectors)
            and all(0.999 <= value <= 1.001 for value in norms),
        }
        encoded = f"{json.dumps(result, indent=2)}\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(encoded, encoding="utf-8")
        print(encoded, end="")
        return 0 if result["passed"] else 1
    finally:
        if created_manifest:
            manifest_path.unlink(missing_ok=True)


def expected_model() -> dict[str, object]:
    return {
        "id": MODEL_ID,
        "version": MODEL_VERSION,
        "dimensions": DIMENSIONS,
        "fingerprint": FINGERPRINT,
    }


def run_packaged(
    executable: Path, model_root: Path, texts: list[str]
) -> tuple[float, float, list[list[float]]]:
    process = subprocess.Popen(
        [str(executable)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )

    def request(command: str, **values: object) -> dict[str, object]:
        assert process.stdin is not None
        assert process.stdout is not None
        request_id = str(request.sequence)
        request.sequence += 1
        process.stdin.write(
            json.dumps({"id": request_id, "command": command, **values}) + "\n"
        )
        process.stdin.flush()
        line = process.stdout.readline()
        if not line:
            raise RuntimeError("Packaged worker closed its output")
        response = json.loads(line)
        if not response.get("ok"):
            raise RuntimeError(f"Packaged worker rejected {command}: {response}")
        return response

    request.sequence = 1  # type: ignore[attr-defined]
    try:
        hello = request("hello")
        if hello.get("runtimeVersion") != "0.8.0-worker.1":
            raise RuntimeError("Packaged worker version mismatch")
        started = time.perf_counter()
        request(
            "load_model", modelDirectory=str(model_root), model=expected_model()
        )
        load_ms = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        response = request("embed_query", texts=texts)
        embed_ms = (time.perf_counter() - started) * 1000
        request("shutdown")
        process.wait(timeout=10)
        if process.returncode != 0:
            raise RuntimeError(f"Packaged worker exited with {process.returncode}")
        vectors = response.get("vectors")
        if not isinstance(vectors, list):
            raise RuntimeError("Packaged worker returned no vectors")
        return load_ms, embed_ms, vectors
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)


if __name__ == "__main__":
    raise SystemExit(main())
