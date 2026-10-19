"""Benchmark a minimal SQLite BLOB + NumPy exact-search semantic index."""

from __future__ import annotations

import argparse
import json
import os
import platform
import sqlite3
import statistics
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import psutil


SCHEMA_VERSION = 1


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(np.ceil(len(ordered) * quantile)) - 1))
    return float(ordered[index])


def rss_bytes() -> int:
    return int(psutil.Process(os.getpid()).memory_info().rss)


def normalize(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.maximum(norms, np.float32(1e-12))


def initialize_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA temp_store=MEMORY")
    connection.executescript(
        """
        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE records (
          id INTEGER PRIMARY KEY,
          namespace TEXT NOT NULL,
          record_id TEXT NOT NULL UNIQUE,
          source_hash TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          vector BLOB NOT NULL
        );
        CREATE INDEX records_namespace_idx ON records(namespace, id);
        """
    )
    connection.executemany(
        "INSERT INTO metadata(key, value) VALUES (?, ?)",
        [
            ("index_schema_version", str(SCHEMA_VERSION)),
            ("dimensions", "384"),
            ("model_id", "phase0-synthetic"),
        ],
    )
    connection.commit()
    return connection


def benchmark_size(
    scratch_dir: Path,
    count: int,
    dimensions: int,
    query_count: int,
    seed: int,
) -> dict[str, Any]:
    database_path = (scratch_dir / f"semantic-{count}-{dimensions}.sqlite").resolve()
    if database_path.parent != scratch_dir.resolve():
        raise RuntimeError("Benchmark database escaped the scratch directory")
    for candidate in (
        database_path,
        Path(f"{database_path}-wal"),
        Path(f"{database_path}-shm"),
    ):
        if candidate.exists():
            candidate.unlink()

    rng = np.random.default_rng(seed + count)
    rss_before = rss_bytes()
    generated_started = time.perf_counter()
    vectors = normalize(rng.standard_normal((count, dimensions), dtype=np.float32))
    generation_seconds = time.perf_counter() - generated_started
    rss_with_source = rss_bytes()

    connection = initialize_database(database_path)
    insert_started = time.perf_counter()
    rows = (
        (
            index + 1,
            "paper",
            f"paper:{index:08d}",
            f"hash:{index:08d}",
            dimensions,
            sqlite3.Binary(vectors[index].tobytes(order="C")),
        )
        for index in range(count)
    )
    with connection:
        connection.executemany(
            """
            INSERT INTO records(
              id, namespace, record_id, source_hash, dimensions, vector
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
    insert_seconds = time.perf_counter() - insert_started
    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    connection.close()
    database_bytes = database_path.stat().st_size

    connection = sqlite3.connect(database_path)
    load_started = time.perf_counter()
    loaded = np.empty((count, dimensions), dtype=np.float32)
    loaded_count = 0
    for loaded_count, (blob,) in enumerate(
        connection.execute("SELECT vector FROM records ORDER BY id"), start=1
    ):
        loaded[loaded_count - 1] = np.frombuffer(blob, dtype="<f4", count=dimensions)
    load_seconds = time.perf_counter() - load_started
    connection.close()
    if loaded_count != count:
        raise RuntimeError(f"Expected {count} vectors, loaded {loaded_count}")
    max_roundtrip_error = float(np.max(np.abs(loaded - vectors)))
    del vectors
    rss_with_loaded = rss_bytes()

    queries = normalize(
        rng.standard_normal((query_count + 5, dimensions), dtype=np.float32)
    )
    for query in queries[:5]:
        scores = loaded @ query
        _ = np.argpartition(scores, -10)[-10:]

    latencies_ms: list[float] = []
    checksum = 0
    for query in queries[5:]:
        started = time.perf_counter()
        scores = loaded @ query
        top = np.argpartition(scores, -10)[-10:]
        top = top[np.argsort(scores[top])[::-1]]
        latencies_ms.append((time.perf_counter() - started) * 1000.0)
        checksum ^= int(top[0])

    return {
        "recordCount": count,
        "dimensions": dimensions,
        "rawVectorBytes": count * dimensions * 4,
        "databaseBytes": database_bytes,
        "databaseOverheadRatio": database_bytes / (count * dimensions * 4),
        "generationSeconds": generation_seconds,
        "insertSeconds": insert_seconds,
        "insertRecordsPerSecond": count / insert_seconds,
        "loadSeconds": load_seconds,
        "searchQueries": query_count,
        "searchMs": {
            "mean": statistics.fmean(latencies_ms),
            "p50": percentile(latencies_ms, 0.50),
            "p95": percentile(latencies_ms, 0.95),
            "max": max(latencies_ms),
        },
        "rssBytes": {
            "before": rss_before,
            "withSourceMatrix": rss_with_source,
            "withLoadedMatrix": rss_with_loaded,
        },
        "maxRoundtripError": max_roundtrip_error,
        "top1Checksum": checksum,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--sizes", default="1000,10000,50000")
    parser.add_argument("--dimensions", type=int, default=384)
    parser.add_argument("--queries", type=int, default=100)
    parser.add_argument("--seed", type=int, default=26082026)
    args = parser.parse_args()

    scratch_dir = args.scratch.resolve()
    scratch_dir.mkdir(parents=True, exist_ok=True)
    sizes = [int(value) for value in args.sizes.split(",") if value.strip()]
    results = [
        benchmark_size(
            scratch_dir,
            count,
            args.dimensions,
            args.queries,
            args.seed,
        )
        for count in sizes
    ]
    largest = max(results, key=lambda entry: entry["recordCount"])
    failures: list[str] = []
    if largest["searchMs"]["p95"] > 250:
        failures.append("50k exact-search p95 exceeded 250 ms")
    if largest["maxRoundtripError"] != 0:
        failures.append("SQLite Float32 BLOB round-trip changed vector values")
    if largest["databaseOverheadRatio"] > 1.5:
        failures.append("SQLite database exceeded 1.5x raw-vector storage")

    report = {
        "prototype": "sqlite-exact-vector-index",
        "environment": {
            "python": sys.version,
            "platform": platform.platform(),
            "numpy": np.__version__,
            "sqlite": sqlite3.sqlite_version,
            "cpuCount": os.cpu_count(),
        },
        "configuration": {
            "schemaVersion": SCHEMA_VERSION,
            "sizes": sizes,
            "dimensions": args.dimensions,
            "queriesPerSize": args.queries,
            "seed": args.seed,
        },
        "measurements": results,
        "failures": failures,
        "decision": "go" if not failures else "no-go",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())

