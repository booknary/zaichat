"""Validate multilingual-e5-small ONNX embeddings against sentence-transformers."""

from __future__ import annotations

import argparse
import gc
import importlib.metadata
import json
import os
import platform
import statistics
import sys
import time
from pathlib import Path
from typing import Any

DEPS_DIR = Path(__file__).resolve().parent / ".python"
if DEPS_DIR.exists():
    sys.path.insert(0, str(DEPS_DIR))

os.environ.setdefault("TRANSFORMERS_NO_TF", "1")
os.environ.setdefault("TRANSFORMERS_NO_FLAX", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np
import onnxruntime as ort
import psutil
from huggingface_hub import hf_hub_download
from onnxruntime.quantization import QuantType, quantize_dynamic
from sentence_transformers import SentenceTransformer
from transformers import AutoTokenizer


MODEL_ID = "intfloat/multilingual-e5-small"
MODEL_REVISION = "0e60b8d9d2166d80387f86e3b48ec9ced55f4d15"
DIMENSIONS = 384
MAX_LENGTH = 512

QUERIES = [
    "帮我找一下，有一篇关于两次基因组创新的文章",
    "novel genomic changes that enabled the origin of land plants",
    "两轮全基因组复制是否促进脊椎动物创新",
    "papers about convergent evolution in arid environments",
]

DOCUMENTS = [
    "The origin of land plants is rooted in two bursts of genomic novelty",
    "Two rounds of whole genome duplication and the origin of vertebrate innovations",
    "Evolutionary constraint and innovation across hundreds of placental mammals",
    "Genome downsizing after polyploidy: mechanisms, rates and selection pressures",
    "Convergent genome evolution shaped the emergence of terrestrial animals",
    "Environmental gradients reveal stress hubs pre-dating plant terrestrialization",
    "Complete chloroplast genome structural characterization of two orchid species",
    "A draft sequence of the rice genome",
    "Gene content evolution in the arthropods",
    "Noncoding regions underpin avian bill shape diversification",
    "Repeated evolution of drought adaptation in desert plants",
    "The genomic basis of convergent evolution in extreme environments",
    "Comparative genomics of fungal symbiosis",
    "Ancient genome duplications in flowering plants",
    "Novel genes and evolutionary innovation after duplication",
    "Origins of multicellularity and regulatory novelty",
    "Genome sequencing technologies: a historical review",
    "CRISPR editing and the second genomic revolution",
    "Terrestrial adaptation in early land plant genomes",
    "Phylogenomics of vocal fold length evolution in mammals",
]


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "missing"


def rss_bytes() -> int:
    return int(psutil.Process(os.getpid()).memory_info().rss)


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(np.ceil(len(ordered) * quantile)) - 1))
    return float(ordered[index])


def l2_normalize(matrix: np.ndarray) -> np.ndarray:
    matrix = np.asarray(matrix, dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.maximum(norms, np.float32(1e-12))


def mean_pool(last_hidden_state: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    mask = np.expand_dims(attention_mask.astype(np.float32), axis=-1)
    summed = np.sum(last_hidden_state.astype(np.float32) * mask, axis=1)
    counts = np.maximum(np.sum(mask, axis=1), np.float32(1.0))
    return summed / counts


def prepare_inputs(tokenizer: Any, texts: list[str]) -> dict[str, np.ndarray]:
    encoded = tokenizer(
        texts,
        padding=True,
        truncation=True,
        max_length=MAX_LENGTH,
        return_tensors="np",
    )
    return {key: np.asarray(value, dtype=np.int64) for key, value in encoded.items()}


def run_onnx(
    session: ort.InferenceSession,
    tokenizer: Any,
    texts: list[str],
) -> np.ndarray:
    encoded = prepare_inputs(tokenizer, texts)
    session_inputs: dict[str, np.ndarray] = {}
    for input_meta in session.get_inputs():
        if input_meta.name in encoded:
            session_inputs[input_meta.name] = encoded[input_meta.name]
        elif input_meta.name == "token_type_ids":
            session_inputs[input_meta.name] = np.zeros_like(encoded["input_ids"])
        else:
            raise RuntimeError(f"Unsupported ONNX input: {input_meta.name}")
    outputs = session.run(None, session_inputs)
    if not outputs or np.asarray(outputs[0]).ndim != 3:
        raise RuntimeError("ONNX encoder did not return last_hidden_state")
    pooled = mean_pool(np.asarray(outputs[0]), encoded["attention_mask"])
    return l2_normalize(pooled)


def cosine_rows(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    return np.sum(l2_normalize(left) * l2_normalize(right), axis=1)


def compare(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    cosines = cosine_rows(reference, candidate)
    norms = np.linalg.norm(candidate, axis=1)
    return {
        "minCosine": float(np.min(cosines)),
        "meanCosine": float(np.mean(cosines)),
        "maxAbsoluteError": float(np.max(np.abs(reference - candidate))),
        "minNorm": float(np.min(norms)),
        "maxNorm": float(np.max(norms)),
    }


def top10_overlap(embeddings_a: np.ndarray, embeddings_b: np.ndarray) -> float:
    query_count = len(QUERIES)
    query_a, documents_a = embeddings_a[:query_count], embeddings_a[query_count:]
    query_b, documents_b = embeddings_b[:query_count], embeddings_b[query_count:]
    overlaps: list[float] = []
    for index in range(query_count):
        rank_a = np.argsort(documents_a @ query_a[index])[::-1][:10]
        rank_b = np.argsort(documents_b @ query_b[index])[::-1][:10]
        overlaps.append(len(set(rank_a.tolist()) & set(rank_b.tolist())) / 10.0)
    return float(statistics.fmean(overlaps))


def benchmark_session(
    session: ort.InferenceSession,
    tokenizer: Any,
    texts: list[str],
    iterations: int,
) -> dict[str, float]:
    run_onnx(session, tokenizer, texts)
    samples: list[float] = []
    for _ in range(iterations):
        started = time.perf_counter()
        run_onnx(session, tokenizer, texts)
        samples.append((time.perf_counter() - started) * 1000.0)
    return {
        "batchSize": len(texts),
        "iterations": iterations,
        "meanMs": statistics.fmean(samples),
        "p50Ms": percentile(samples, 0.50),
        "p95Ms": percentile(samples, 0.95),
        "textsPerSecond": len(texts) * 1000.0 / statistics.fmean(samples),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=10)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    args.scratch.mkdir(parents=True, exist_ok=True)

    failures: list[str] = []
    rss_started = rss_bytes()
    texts = [f"query: {text}" for text in QUERIES] + [
        f"passage: {text}" for text in DOCUMENTS
    ]

    reference_started = time.perf_counter()
    reference_model = SentenceTransformer(
        MODEL_ID,
        revision=MODEL_REVISION,
        cache_folder=str(args.cache),
        device="cpu",
    )
    reference_embeddings = np.asarray(
        reference_model.encode(
            texts,
            batch_size=8,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        ),
        dtype=np.float32,
    )
    reference_seconds = time.perf_counter() - reference_started
    rss_reference = rss_bytes()
    del reference_model
    gc.collect()

    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        cache_dir=str(args.cache),
        use_fast=True,
    )
    fp32_path = Path(
        hf_hub_download(
            repo_id=MODEL_ID,
            filename="onnx/model.onnx",
            revision=MODEL_REVISION,
            cache_dir=str(args.cache),
        )
    )
    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = max(1, min(8, os.cpu_count() or 1))
    session_options.inter_op_num_threads = 1
    fp32_load_started = time.perf_counter()
    fp32_session = ort.InferenceSession(
        str(fp32_path),
        sess_options=session_options,
        providers=["CPUExecutionProvider"],
    )
    fp32_load_seconds = time.perf_counter() - fp32_load_started
    fp32_embeddings = run_onnx(fp32_session, tokenizer, texts)
    fp32_comparison = compare(reference_embeddings, fp32_embeddings)
    fp32_benchmark = benchmark_session(
        fp32_session, tokenizer, texts[:8], args.iterations
    )
    rss_fp32 = rss_bytes()
    del fp32_session
    gc.collect()

    quantized_variants: list[dict[str, Any]] = []
    for name, weight_type, per_channel, reduce_range in (
        ("qint8", QuantType.QInt8, False, False),
        ("quint8", QuantType.QUInt8, False, False),
        ("qint8-per-channel-reduced", QuantType.QInt8, True, True),
    ):
        quantized_path = args.scratch / f"multilingual-e5-small-{name}.onnx"
        quantize_started = time.perf_counter()
        quantize_dynamic(
            model_input=str(fp32_path),
            model_output=str(quantized_path),
            weight_type=weight_type,
            per_channel=per_channel,
            reduce_range=reduce_range,
        )
        quantize_seconds = time.perf_counter() - quantize_started
        load_started = time.perf_counter()
        session = ort.InferenceSession(
            str(quantized_path),
            sess_options=session_options,
            providers=["CPUExecutionProvider"],
        )
        load_seconds = time.perf_counter() - load_started
        embeddings = run_onnx(session, tokenizer, texts)
        comparison = compare(fp32_embeddings, embeddings)
        reference_comparison = compare(reference_embeddings, embeddings)
        overlap = top10_overlap(reference_embeddings, embeddings)
        benchmark = benchmark_session(session, tokenizer, texts[:8], args.iterations)
        quantized_variants.append(
            {
                "name": name,
                "path": str(quantized_path),
                "bytes": quantized_path.stat().st_size,
                "quantizeSeconds": quantize_seconds,
                "loadSeconds": load_seconds,
                "comparisonToFp32": comparison,
                "comparisonToReference": reference_comparison,
                "top10Overlap": overlap,
                "benchmark": benchmark,
                "rssBytes": rss_bytes(),
            }
        )
        del session, embeddings
        gc.collect()
    best_quantized = max(
        quantized_variants,
        key=lambda entry: (
            entry["comparisonToFp32"]["minCosine"],
            entry["top10Overlap"],
        ),
    )
    q8_comparison = best_quantized["comparisonToFp32"]
    q8_top10_overlap = best_quantized["top10Overlap"]

    if reference_embeddings.shape != (len(texts), DIMENSIONS):
        failures.append(f"Reference shape was {reference_embeddings.shape}")
    if fp32_comparison["minCosine"] < 0.9999:
        failures.append("ONNX FP32 cosine against sentence-transformers was below 0.9999")
    if fp32_comparison["maxAbsoluteError"] > 1e-4:
        failures.append("ONNX FP32 maximum absolute error exceeded 1e-4")
    if q8_comparison["minCosine"] < 0.995:
        failures.append("ONNX INT8 cosine against ONNX FP32 was below 0.995")
    if q8_top10_overlap < 0.95:
        failures.append("ONNX INT8 Top-10 overlap was below 95%")
    for name, comparison in (
        ("fp32", fp32_comparison),
        ("q8", q8_comparison),
    ):
        if comparison["minNorm"] < 0.999 or comparison["maxNorm"] > 1.001:
            failures.append(f"{name} L2 norms were outside 0.999-1.001")

    report = {
        "prototype": "multilingual-e5-small-onnx-correctness",
        "environment": {
            "python": sys.version,
            "platform": platform.platform(),
            "processorIdentifier": os.environ.get("PROCESSOR_IDENTIFIER", "unknown"),
            "cpuCount": os.cpu_count(),
            "packages": {
                "sentence-transformers": package_version("sentence-transformers"),
                "transformers": package_version("transformers"),
                "onnxruntime": ort.__version__,
                "onnx": package_version("onnx"),
                "torch": package_version("torch"),
                "numpy": np.__version__,
            },
        },
        "model": {
            "id": MODEL_ID,
            "revision": MODEL_REVISION,
            "dimensions": DIMENSIONS,
            "maxLength": MAX_LENGTH,
            "fp32Path": str(fp32_path),
            "fp32Bytes": fp32_path.stat().st_size,
            "selectedQuantizedVariant": best_quantized["name"],
            "q8Path": best_quantized["path"],
            "q8Bytes": best_quantized["bytes"],
        },
        "measurements": {
            "textCount": len(texts),
            "referenceLoadAndEncodeSeconds": reference_seconds,
            "fp32LoadSeconds": fp32_load_seconds,
            "fp32Comparison": fp32_comparison,
            "fp32Benchmark": fp32_benchmark,
            "quantizedVariants": quantized_variants,
            "rssBytes": {
                "started": rss_started,
                "withReference": rss_reference,
                "withFp32": rss_fp32,
                "afterQuantizedVariants": rss_bytes(),
            },
        },
        "failures": failures,
        "decisions": {
            "tokenizerEncoderPoolingNormalization": (
                "go"
                if fp32_comparison["minCosine"] >= 0.9999
                and fp32_comparison["maxAbsoluteError"] <= 1e-4
                else "no-go"
            ),
            "dynamicInt8Artifact": (
                "go"
                if q8_comparison["minCosine"] >= 0.995
                and q8_top10_overlap >= 0.95
                else "no-go"
            ),
        },
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
