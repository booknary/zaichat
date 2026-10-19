import { SemanticModelFingerprint, SemanticModelFingerprintInput } from "./types";

export async function createModelFingerprint(
  input: SemanticModelFingerprintInput,
): Promise<SemanticModelFingerprint> {
  if (!input.modelID.trim()) throw new Error("Semantic model ID is required");
  if (!input.version.trim()) throw new Error("Semantic model version is required");
  if (!Number.isInteger(input.dimensions) || input.dimensions <= 0)
    throw new Error("Semantic model dimensions must be a positive integer");
  const canonical = JSON.stringify({
    modelID: input.modelID.trim(),
    version: input.version.trim(),
    dimensions: input.dimensions,
    modelSHA256: normalizeDigest(input.modelSHA256, "model"),
    tokenizerSHA256: normalizeDigest(input.tokenizerSHA256, "tokenizer"),
    pooling: input.pooling,
    normalization: input.normalization,
  });
  return {
    ...JSON.parse(canonical),
    fingerprint: await sha256Hex(canonical),
  } as SemanticModelFingerprint;
}

export async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error("WebCrypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeDigest(value: string, label: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized))
    throw new Error(`Semantic ${label} SHA-256 must contain 64 hexadecimal digits`);
  return normalized;
}
