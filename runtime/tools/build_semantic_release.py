"""Stage, finalize, and verify ZaiChat semantic release artifacts.

Staging deliberately does not create downloadable manifests. A release manifest is
only written after a real HTTPS release base is supplied to ``finalize``.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse


CHUNK_SIZE = 1024 * 1024
FORMAT_VERSION = 1
MARKER_FILE = ".zaichat-semantic-release-root"
DESCRIPTOR_FILE = "release-descriptor.json"
MANIFEST_DIRECTORY = "manifests"
ASSET_DIRECTORY = "assets"
MODEL_FILES = (
    "onnx/model.onnx",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "sentencepiece.bpe.model",
    "config.json",
    "README.md",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp-{os.getpid()}")
    temporary.write_text(
        f"{json.dumps(value, indent=2, ensure_ascii=False)}\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


def safe_asset_component(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-.")
    if not normalized:
        raise ValueError("Release asset component is empty")
    return normalized


def create_model_fingerprint(
    model_id: str,
    version: str,
    dimensions: int,
    model_sha256: str,
    tokenizer_sha256: str,
) -> dict[str, Any]:
    canonical: dict[str, Any] = {
        "modelID": model_id.strip(),
        "version": version.strip(),
        "dimensions": dimensions,
        "modelSHA256": model_sha256.lower(),
        "tokenizerSHA256": tokenizer_sha256.lower(),
        "pooling": "mean",
        "normalization": "l2",
    }
    encoded = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"))
    return {
        **canonical,
        "fingerprint": hashlib.sha256(encoded.encode("utf-8")).hexdigest(),
    }


def ensure_clean_output(output: Path, replace: bool) -> None:
    if not output.exists():
        return
    if not any(output.iterdir()):
        return
    marker = output / MARKER_FILE
    if not replace:
        raise ValueError("Release output already exists; pass --replace to rebuild it")
    if not marker.is_file():
        raise ValueError("Refusing to replace an unmarked release output directory")
    payload = json.loads(marker.read_text(encoding="utf-8"))
    if payload != {"formatVersion": FORMAT_VERSION, "managedBy": "ZaiChat"}:
        raise ValueError("Release output marker is invalid")
    shutil.rmtree(output)


def link_or_copy(source: Path, destination: Path) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
        return "hardlink"
    except OSError:
        shutil.copy2(source, destination)
        return "copy"


def staged_file(
    source: Path,
    destination: Path,
    relative_path: str,
    asset_name: str,
    executable: bool = False,
) -> tuple[dict[str, Any], str]:
    transfer = link_or_copy(source, destination / ASSET_DIRECTORY / asset_name)
    entry: dict[str, Any] = {
        "relativePath": relative_path,
        "assetName": asset_name,
        "size": source.stat().st_size,
        "sha256": sha256_file(source),
    }
    if executable:
        entry["executable"] = True
    return entry, transfer


def stage(args: argparse.Namespace) -> int:
    runtime = args.runtime_executable.resolve(strict=True)
    model_root = args.model_root.resolve(strict=True)
    output = args.output.resolve()
    if not runtime.is_file() or runtime.suffix.lower() != ".exe":
        raise ValueError("Runtime executable must be a Windows .exe file")
    if not args.model_id.strip() or not args.model_version.strip():
        raise ValueError("Model ID and version are required")
    if not isinstance(args.dimensions, int) or args.dimensions <= 0:
        raise ValueError("Model dimensions must be a positive integer")
    sources = {relative: model_root / relative for relative in MODEL_FILES}
    missing = [relative for relative, path in sources.items() if not path.is_file()]
    if missing:
        raise ValueError(f"Model snapshot is incomplete: {', '.join(missing)}")

    ensure_clean_output(output, args.replace)
    output.mkdir(parents=True, exist_ok=True)
    atomic_json(
        output / MARKER_FILE,
        {"formatVersion": FORMAT_VERSION, "managedBy": "ZaiChat"},
    )

    transfers: dict[str, int] = {"hardlink": 0, "copy": 0}
    runtime_version = safe_asset_component(args.runtime_version)
    runtime_asset = f"zaichat-embedding-worker-win-x64-{runtime_version}.exe"
    runtime_entry, transfer = staged_file(
        runtime,
        output,
        "zaichat-embedding-worker.exe",
        runtime_asset,
        executable=True,
    )
    transfers[transfer] += 1

    model_prefix = safe_asset_component(args.model_id.split("/")[-1])
    version_prefix = safe_asset_component(args.model_version[:12])
    model_entries: list[dict[str, Any]] = []
    for relative, source in sources.items():
        leaf = safe_asset_component(relative.replace("/", "-"))
        asset_name = f"{model_prefix}-{version_prefix}-{leaf}"
        entry, transfer = staged_file(
            source, output, relative, asset_name, executable=False
        )
        model_entries.append(entry)
        transfers[transfer] += 1

    notice_name = f"{model_prefix}-{version_prefix}-THIRD_PARTY_NOTICES.txt"
    notice_path = output / ASSET_DIRECTORY / notice_name
    notice_path.write_text(
        "ZaiChat semantic model artifact\n"
        f"Model: {args.model_id}\n"
        f"Revision: {args.model_version}\n"
        f"Source: https://huggingface.co/{args.model_id}\n"
        "Declared license: MIT (see bundled README.md model card).\n",
        encoding="utf-8",
        newline="\n",
    )
    model_entries.append(
        {
            "relativePath": "THIRD_PARTY_NOTICES.txt",
            "assetName": notice_name,
            "size": notice_path.stat().st_size,
            "sha256": sha256_file(notice_path),
        }
    )

    by_path = {entry["relativePath"]: entry for entry in model_entries}
    fingerprint = create_model_fingerprint(
        args.model_id,
        args.model_version,
        args.dimensions,
        by_path["onnx/model.onnx"]["sha256"],
        by_path["tokenizer.json"]["sha256"],
    )
    descriptor = {
        "formatVersion": FORMAT_VERSION,
        "state": "staged",
        "platform": "win-x64",
        "packages": [
            {
                "packageType": "runtime",
                "packageID": args.runtime_package_id,
                "version": args.runtime_version,
                "files": [runtime_entry],
            },
            {
                "packageType": "model",
                "packageID": args.model_package_id,
                "version": args.model_version,
                "model": fingerprint,
                "files": model_entries,
            },
        ],
    }
    atomic_json(output / DESCRIPTOR_FILE, descriptor)
    verify_root(output, require_manifests=False, allow_test_url=False)
    print(
        json.dumps(
            {
                "staged": True,
                "files": 1 + len(model_entries),
                "bytes": sum(
                    entry["size"]
                    for package in descriptor["packages"]
                    for entry in package["files"]
                ),
                "transfers": transfers,
                "publishable": False,
            }
        )
    )
    return 0


def validate_release_url(url_base: str, allow_test_url: bool) -> str:
    parsed = urlparse(url_base)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("Release URL base must be an absolute HTTPS URL")
    hostname = parsed.hostname.lower().rstrip(".")
    reserved = (
        hostname == "localhost"
        or hostname.endswith((".localhost", ".invalid", ".test", ".example"))
        or hostname in {"example.com", "example.org", "example.net"}
    )
    try:
        reserved = reserved or ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        pass
    if reserved and not allow_test_url:
        raise ValueError("Placeholder or local release URL cannot be finalized")
    return url_base.rstrip("/")


def manifest_from_package(package: dict[str, Any], url_base: str) -> dict[str, Any]:
    files = []
    for entry in package["files"]:
        manifest_entry: dict[str, Any] = {
            "relativePath": entry["relativePath"],
            "size": entry["size"],
            "sha256": entry["sha256"],
        }
        manifest_entry["url"] = f"{url_base}/{quote(entry['assetName'])}"
        if entry.get("executable") is True:
            manifest_entry["executable"] = True
        files.append(manifest_entry)
    result = {
        "formatVersion": FORMAT_VERSION,
        "packageType": package["packageType"],
        "packageID": package["packageID"],
        "version": package["version"],
        "platform": "win-x64",
    }
    if package["packageType"] == "model":
        result["model"] = package["model"]
    result["files"] = files
    return result


def install_local(args: argparse.Namespace) -> int:
    root = args.root.resolve(strict=True)
    descriptor = verify_root(root, require_manifests=False, allow_test_url=True)
    destination = args.destination.resolve()
    marker_path = destination / ".zaichat-semantic-model-root"
    marker_value = {
        "installationID": args.installation_id,
        "formatVersion": FORMAT_VERSION,
    }
    if destination.exists() and any(destination.iterdir()):
        if not marker_path.is_file():
            raise ValueError("Refusing to modify an unmarked semantic artifact root")
        if json.loads(marker_path.read_text(encoding="utf-8")) != marker_value:
            raise ValueError("Semantic artifact root belongs to another installation")
    else:
        destination.mkdir(parents=True, exist_ok=True)
        atomic_json(marker_path, marker_value)

    transfers = {"hardlink": 0, "copy": 0}
    local_base = "https://semantic-assets.zaichat.invalid/local-test"
    for package in descriptor["packages"]:
        package_root = (
            destination
            / safe_asset_component(package["packageType"])
            / quote(str(package["packageID"]), safe="")
            / safe_asset_component(str(package["version"]))
        )
        if package_root.exists():
            if not args.replace:
                raise ValueError(
                    f"Local semantic package already exists: {package['packageID']}"
                )
            manifest_path = package_root / "manifest.json"
            if not manifest_path.is_file():
                raise ValueError("Refusing to replace an unmarked local package")
            shutil.rmtree(package_root)
        for entry in package["files"]:
            source = root / ASSET_DIRECTORY / entry["assetName"]
            target = package_root.joinpath(*entry["relativePath"].split("/"))
            transfer = link_or_copy(source, target)
            transfers[transfer] += 1
        atomic_json(
            package_root / "manifest.json",
            manifest_from_package(package, local_base),
        )
    print(
        json.dumps(
            {
                "installed": True,
                "destination": str(destination),
                "packages": len(descriptor["packages"]),
                "transfers": transfers,
            }
        )
    )
    return 0


def finalize(args: argparse.Namespace) -> int:
    root = args.root.resolve(strict=True)
    url_base = validate_release_url(args.url_base, args.allow_test_url)
    descriptor = verify_root(
        root, require_manifests=False, allow_test_url=args.allow_test_url
    )
    manifest_root = root / MANIFEST_DIRECTORY
    manifest_root.mkdir(parents=True, exist_ok=True)
    names = {
        "runtime": "embedding-runtime-win-x64.json",
        "model": "multilingual-e5-small.json",
    }
    for package in descriptor["packages"]:
        atomic_json(
            manifest_root / names[package["packageType"]],
            manifest_from_package(package, url_base),
        )
    descriptor["state"] = "finalized"
    descriptor["releaseBase"] = url_base
    atomic_json(root / DESCRIPTOR_FILE, descriptor)
    verify_root(root, require_manifests=True, allow_test_url=args.allow_test_url)
    print(json.dumps({"finalized": True, "releaseBase": url_base}))
    return 0


def validate_entry(entry: Any) -> None:
    if not isinstance(entry, dict):
        raise ValueError("Release file entry is invalid")
    relative = entry.get("relativePath")
    asset = entry.get("assetName")
    if not isinstance(relative, str) or not relative or ".." in relative.split("/"):
        raise ValueError("Release relative path is unsafe")
    if not isinstance(asset, str) or asset != Path(asset).name:
        raise ValueError("Release asset name is unsafe")
    if not isinstance(entry.get("size"), int) or entry["size"] < 0:
        raise ValueError("Release file size is invalid")
    if not re.fullmatch(r"[a-f0-9]{64}", str(entry.get("sha256", ""))):
        raise ValueError("Release file checksum is invalid")


def verify_root(
    root: Path, require_manifests: bool, allow_test_url: bool
) -> dict[str, Any]:
    marker = json.loads((root / MARKER_FILE).read_text(encoding="utf-8"))
    if marker != {"formatVersion": FORMAT_VERSION, "managedBy": "ZaiChat"}:
        raise ValueError("Release root marker is invalid")
    descriptor = json.loads((root / DESCRIPTOR_FILE).read_text(encoding="utf-8"))
    packages = descriptor.get("packages")
    if descriptor.get("formatVersion") != FORMAT_VERSION or not isinstance(
        packages, list
    ):
        raise ValueError("Release descriptor is invalid")
    if [package.get("packageType") for package in packages] != ["runtime", "model"]:
        raise ValueError("Release descriptor package order or types are invalid")

    expected_assets: set[str] = set()
    for package in packages:
        files = package.get("files")
        if not isinstance(files, list) or not files:
            raise ValueError("Release package contains no files")
        for entry in files:
            validate_entry(entry)
            if entry["assetName"] in expected_assets:
                raise ValueError("Release asset name is duplicated")
            expected_assets.add(entry["assetName"])
            path = root / ASSET_DIRECTORY / entry["assetName"]
            if not path.is_file() or path.stat().st_size != entry["size"]:
                raise ValueError(f"Release asset size mismatch: {entry['assetName']}")
            if sha256_file(path) != entry["sha256"]:
                raise ValueError(f"Release asset checksum mismatch: {entry['assetName']}")
    runtime_files = packages[0]["files"]
    if len(runtime_files) != 1 or runtime_files[0].get("executable") is not True:
        raise ValueError("Runtime package must contain exactly one executable")

    model = packages[1].get("model")
    paths = {entry["relativePath"]: entry for entry in packages[1]["files"]}
    if not isinstance(model, dict) or "onnx/model.onnx" not in paths:
        raise ValueError("Model package fingerprint or encoder is missing")
    expected_fingerprint = create_model_fingerprint(
        model.get("modelID", ""),
        model.get("version", ""),
        model.get("dimensions", 0),
        paths["onnx/model.onnx"]["sha256"],
        paths["tokenizer.json"]["sha256"],
    )
    if model != expected_fingerprint:
        raise ValueError("Model fingerprint does not match staged assets")

    actual_assets = {
        path.name for path in (root / ASSET_DIRECTORY).iterdir() if path.is_file()
    }
    if actual_assets != expected_assets:
        raise ValueError("Release asset directory contains unexpected files")

    manifests = root / MANIFEST_DIRECTORY
    if require_manifests or descriptor.get("state") == "finalized":
        if descriptor.get("state") != "finalized":
            raise ValueError("Release descriptor is not finalized")
        release_base = validate_release_url(
            str(descriptor.get("releaseBase", "")), allow_test_url
        )
        names = (
            "embedding-runtime-win-x64.json",
            "multilingual-e5-small.json",
        )
        for package, name in zip(packages, names, strict=True):
            actual = json.loads((manifests / name).read_text(encoding="utf-8"))
            expected = manifest_from_package(package, release_base)
            if actual != expected:
                raise ValueError(f"Finalized manifest does not match: {name}")
    return descriptor


def verify(args: argparse.Namespace) -> int:
    descriptor = verify_root(
        args.root.resolve(strict=True),
        require_manifests=args.require_manifests,
        allow_test_url=args.allow_test_url,
    )
    file_count = sum(len(package["files"]) for package in descriptor["packages"])
    print(
        json.dumps(
            {
                "verified": True,
                "state": descriptor["state"],
                "files": file_count,
            }
        )
    )
    return 0


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    commands = value.add_subparsers(dest="command", required=True)
    stage_parser = commands.add_parser("stage")
    stage_parser.add_argument("--runtime-executable", type=Path, required=True)
    stage_parser.add_argument("--runtime-version", required=True)
    stage_parser.add_argument(
        "--runtime-package-id", default="zaichat/embedding-worker"
    )
    stage_parser.add_argument("--model-root", type=Path, required=True)
    stage_parser.add_argument("--model-id", required=True)
    stage_parser.add_argument("--model-version", required=True)
    stage_parser.add_argument(
        "--model-package-id", default="intfloat/multilingual-e5-small"
    )
    stage_parser.add_argument("--dimensions", type=int, required=True)
    stage_parser.add_argument("--output", type=Path, required=True)
    stage_parser.add_argument("--replace", action="store_true")
    stage_parser.set_defaults(handler=stage)

    finalize_parser = commands.add_parser("finalize")
    finalize_parser.add_argument("--root", type=Path, required=True)
    finalize_parser.add_argument("--url-base", required=True)
    finalize_parser.add_argument("--allow-test-url", action="store_true")
    finalize_parser.set_defaults(handler=finalize)

    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--root", type=Path, required=True)
    verify_parser.add_argument("--require-manifests", action="store_true")
    verify_parser.add_argument("--allow-test-url", action="store_true")
    verify_parser.set_defaults(handler=verify)

    install_parser = commands.add_parser("install-local")
    install_parser.add_argument("--root", type=Path, required=True)
    install_parser.add_argument("--destination", type=Path, required=True)
    install_parser.add_argument(
        "--installation-id", default="zaichat@booknary.github.io"
    )
    install_parser.add_argument("--replace", action="store_true")
    install_parser.set_defaults(handler=install_local)
    return value


def main() -> int:
    try:
        args = parser().parse_args()
        return int(args.handler(args))
    except Exception as error:
        print(f"release-error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
