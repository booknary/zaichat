import { SemanticArtifactManifest } from "./semanticArtifactManager";

const ASSET_BASE = "https://semantic-assets.zaichat.invalid/local-test";

export const SEMANTIC_RUNTIME_MANIFEST: SemanticArtifactManifest = {
  formatVersion: 1,
  packageType: "runtime",
  packageID: "zaichat/embedding-worker",
  version: "0.8.0-worker.1",
  platform: "win-x64",
  files: [
    {
      relativePath: "zaichat-embedding-worker.exe",
      size: 44342570,
      sha256: "44dad54c16773b484e00b04d03524872ec5778bff604b514ffc3ce0c2eed397e",
      url: `${ASSET_BASE}/zaichat-embedding-worker-win-x64-0.8.0-worker.1.exe`,
      executable: true,
    },
  ],
};

export const SEMANTIC_MODEL_MANIFEST: SemanticArtifactManifest = {
  formatVersion: 1,
  packageType: "model",
  packageID: "intfloat/multilingual-e5-small",
  version: "0e60b8d9d2166d80387f86e3b48ec9ced55f4d15",
  platform: "win-x64",
  model: {
    modelID: "intfloat/multilingual-e5-small",
    version: "0e60b8d9d2166d80387f86e3b48ec9ced55f4d15",
    dimensions: 384,
    modelSHA256: "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665",
    tokenizerSHA256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    pooling: "mean",
    normalization: "l2",
    fingerprint: "479e1869a1750f0891d281561e4654afec1c58c7aaeddc48ac4302ffcbdd0bb3",
  },
  files: [
    artifact(
      "onnx/model.onnx",
      470268510,
      "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665",
      "multilingual-e5-small-0e60b8d9d216-onnx-model.onnx",
    ),
    artifact(
      "tokenizer.json",
      17082730,
      "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
      "multilingual-e5-small-0e60b8d9d216-tokenizer.json",
    ),
    artifact(
      "tokenizer_config.json",
      443,
      "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
      "multilingual-e5-small-0e60b8d9d216-tokenizer_config.json",
    ),
    artifact(
      "special_tokens_map.json",
      167,
      "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
      "multilingual-e5-small-0e60b8d9d216-special_tokens_map.json",
    ),
    artifact(
      "sentencepiece.bpe.model",
      5069051,
      "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865",
      "multilingual-e5-small-0e60b8d9d216-sentencepiece.bpe.model",
    ),
    artifact(
      "config.json",
      655,
      "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959",
      "multilingual-e5-small-0e60b8d9d216-config.json",
    ),
    artifact(
      "README.md",
      497538,
      "0038de97aee16258cecbad7ffda4b4febd6953e747a00e0ddbc8e6ed241e9c1c",
      "multilingual-e5-small-0e60b8d9d216-README.md",
    ),
    artifact(
      "THIRD_PARTY_NOTICES.txt",
      241,
      "020f130e511a32ea50ed023535560b6196496a1e94647b0083c58c5b9a41e29e",
      "multilingual-e5-small-0e60b8d9d216-THIRD_PARTY_NOTICES.txt",
    ),
  ],
};

function artifact(
  relativePath: string,
  size: number,
  sha256: string,
  assetName: string,
) {
  return {
    relativePath,
    size,
    sha256,
    url: `${ASSET_BASE}/${assetName}`,
  };
}
