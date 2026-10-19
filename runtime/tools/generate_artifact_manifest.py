"""Generate or verify deterministic ZaiChat semantic artifact manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote
from urllib.parse import urlparse


CHUNK_SIZE = 1024 * 1024


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def generate(args: argparse.Namespace) -> int:
    root = args.root.resolve(strict=True)
    output = args.output.resolve()
    if output == root or root not in output.parents:
        raise ValueError("Manifest output must be inside the artifact root")
    parsed = urlparse(args.url_base)
    if parsed.scheme != "https":
        raise ValueError("Artifact URL base must use HTTPS")
    executable = args.executable.replace("\\", "/") if args.executable else None
    files: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*"), key=lambda value: value.as_posix()):
        if not path.is_file() or path.resolve() == output:
            continue
        relative = normalized_relative(path, root)
        files.append(
            {
                "relativePath": relative,
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
                "url": f"{args.url_base.rstrip('/')}/{quote(relative)}",
                **({"executable": True} if relative == executable else {}),
            }
        )
    if not files:
        raise ValueError("Artifact root contains no files")
    if args.package_type == "runtime":
        matches = [entry for entry in files if entry.get("executable")]
        if len(matches) != 1:
            raise ValueError("Runtime manifest requires one --executable file")
    manifest: dict[str, Any] = {
        "formatVersion": 1,
        "packageType": args.package_type,
        "packageID": args.package_id,
        "version": args.version,
        "platform": "win-x64",
        "files": files,
    }
    if args.model_fingerprint:
        model = json.loads(args.model_fingerprint.read_text(encoding="utf-8"))
        validate_model_fingerprint(model)
        manifest["model"] = model
    elif args.package_type == "model":
        raise ValueError("Model manifest requires --model-fingerprint")
    encoded = f"{json.dumps(manifest, indent=2, ensure_ascii=False)}\n"
    temporary = output.with_suffix(f"{output.suffix}.tmp-{os.getpid()}")
    temporary.write_text(encoded, encoding="utf-8", newline="\n")
    os.replace(temporary, output)
    print(json.dumps({"files": len(files), "bytes": sum(x["size"] for x in files)}))
    return 0


def verify(args: argparse.Namespace) -> int:
    manifest_path = args.manifest.resolve(strict=True)
    root = args.root.resolve(strict=True)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("Manifest file list is invalid")
    seen: set[str] = set()
    for entry in files:
        relative = entry.get("relativePath")
        if not isinstance(relative, str) or relative in seen:
            raise ValueError("Manifest contains an invalid or duplicate path")
        seen.add(relative)
        path = (root / relative).resolve(strict=True)
        if root not in path.parents:
            raise ValueError("Manifest path escaped the artifact root")
        if path.stat().st_size != entry.get("size"):
            raise ValueError(f"Size mismatch: {relative}")
        if sha256_file(path) != entry.get("sha256"):
            raise ValueError(f"SHA-256 mismatch: {relative}")
        if urlparse(str(entry.get("url", ""))).scheme != "https":
            raise ValueError(f"Non-HTTPS artifact URL: {relative}")
    if manifest.get("packageType") == "runtime":
        if sum(bool(entry.get("executable")) for entry in files) != 1:
            raise ValueError("Runtime manifest must contain one executable")
    if manifest.get("packageType") == "model":
        validate_model_fingerprint(manifest.get("model"))
    print(json.dumps({"verified": True, "files": len(files)}))
    return 0


def validate_model_fingerprint(value: Any) -> None:
    if not isinstance(value, dict):
        raise ValueError("Model fingerprint must be an object")
    for field in ("modelID", "version", "fingerprint"):
        if not isinstance(value.get(field), str) or not value[field]:
            raise ValueError(f"Model fingerprint field is invalid: {field}")
    if not isinstance(value.get("dimensions"), int) or value["dimensions"] <= 0:
        raise ValueError("Model dimensions are invalid")
    for field in ("modelSHA256", "tokenizerSHA256", "fingerprint"):
        digest = value.get(field)
        if not isinstance(digest, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", digest):
            raise ValueError(f"Model digest is invalid: {field}")


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    subparsers = value.add_subparsers(dest="command", required=True)
    generate_parser = subparsers.add_parser("generate")
    generate_parser.add_argument("--root", type=Path, required=True)
    generate_parser.add_argument("--output", type=Path, required=True)
    generate_parser.add_argument(
        "--package-type", choices=("runtime", "model"), required=True
    )
    generate_parser.add_argument("--package-id", required=True)
    generate_parser.add_argument("--version", required=True)
    generate_parser.add_argument("--url-base", required=True)
    generate_parser.add_argument("--executable")
    generate_parser.add_argument("--model-fingerprint", type=Path)
    generate_parser.set_defaults(handler=generate)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--root", type=Path, required=True)
    verify_parser.add_argument("--manifest", type=Path, required=True)
    verify_parser.set_defaults(handler=verify)
    return value


def main() -> int:
    try:
        args = parser().parse_args()
        return int(args.handler(args))
    except Exception as error:
        print(f"manifest-error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
