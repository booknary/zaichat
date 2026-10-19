import { SemanticArtifactManifest } from "./semanticArtifactManager";
import { SEMANTIC_MODEL_MANIFEST } from "./releaseManifests";

export const E5_MODEL_IDS = ["small", "base", "large"] as const;
export type E5ModelID = (typeof E5_MODEL_IDS)[number];

export function e5ModelID(value: unknown): E5ModelID {
  if (value === undefined || value === null || value === "") return "small";
  if (!E5_MODEL_IDS.includes(value as E5ModelID))
    throw new Error("Unknown embedding model");
  return value as E5ModelID;
}

export function e5Manifest(id: E5ModelID): SemanticArtifactManifest {
  if (id === "small") {
    // Keep the established fingerprint and files so existing installations/indexes survive.
    return {
      ...SEMANTIC_MODEL_MANIFEST,
      files: SEMANTIC_MODEL_MANIFEST.files.map((file) => ({
        ...file,
        url:
          file.relativePath === "THIRD_PARTY_NOTICES.txt"
            ? file.url
            : `https://hf-mirror.com/intfloat/multilingual-e5-small/resolve/${SEMANTIC_MODEL_MANIFEST.version}/${file.relativePath}`,
      })),
    };
  }
  const large = id === "large";
  const version = large
    ? "3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3"
    : "d128750597153bb5987e10b1c3493a34e5a4502a";
  const modelSHA256 = large
    ? "bb5a52503a3ef35247f5b5ae6c473aaae60505dd3ffaef56d7b69e2f84683c05"
    : "84a4d426f7e87a6bf5bf195f0bae2c4a7d15f675b23ca96f42fab8326d7a77aa";
  const tokenizerSHA256 =
    "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626";
  const file = (relativePath: string, size: number, sha256: string) => ({
    relativePath,
    size,
    sha256,
    url: `https://hf-mirror.com/intfloat/multilingual-e5-${id}/resolve/${version}/${relativePath}`,
  });
  return {
    formatVersion: 1,
    packageType: "model",
    platform: "win-x64",
    packageID: `intfloat/multilingual-e5-${id}`,
    version,
    model: {
      modelID: `intfloat/multilingual-e5-${id}`,
      version,
      dimensions: large ? 1024 : 768,
      modelSHA256,
      tokenizerSHA256,
      pooling: "mean",
      normalization: "l2",
      fingerprint: large
        ? "94c3ed0ec39287612fe6938d2024dad430cf94155fb7ea95a401142d899f5f31"
        : "66aca7b4f8bf89eeb171c751a871a8e349982c39bbad510efbb165e0476e834a",
    },
    files: [
      file("onnx/model.onnx", large ? 545850 : 1110059084, modelSHA256),
      ...(large
        ? [
            file(
              "onnx/model.onnx_data",
              2235363328,
              "0cf1883fee81c63819a44e2ba0efa51d4043d9759685a4ebebbde97e0623d15c",
            ),
          ]
        : []),
      file("tokenizer.json", 17082660, tokenizerSHA256),
      file(
        "README.md",
        large ? 160024 : 179345,
        large
          ? "7d7af14813a22388e183b0ac3276e13887c7eb644d0a13af7c6252217066e43f"
          : "9d129cb0b912b55c7b5378f976a9c35ae4796c80466b659ad63930d8ca090fca",
      ),
    ],
  };
}

export function modelIndexRoot(
  profile: string,
  model: SemanticArtifactManifest,
  join: (...parts: string[]) => string,
): string {
  return model.model?.fingerprint === SEMANTIC_MODEL_MANIFEST.model!.fingerprint
    ? join(profile, "zaichat", "semantic")
    : join(profile, "zaichat", "semantic-models", model.model!.fingerprint);
}
