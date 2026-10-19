import { afterEach, expect, it, vi } from "vitest";
import {
  HTTPSemanticArtifactSource,
  SemanticDownloadError,
} from "../src/semantic/semanticArtifactManager";
afterEach(() => vi.unstubAllGlobals());
const file = {
  relativePath: "onnx/model.onnx",
  url: "https://huggingface.co/model?private=value",
  size: 10,
  sha256: "a".repeat(64),
};

it("reports failed model file and stage without exposing URL query values", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("NetworkError");
    }),
  );
  try {
    for await (const _chunk of new HTTPSemanticArtifactSource().read(file)) {
      /* read until failure */
    }
    throw new Error("Expected a network failure");
  } catch (error) {
    expect(error).toBeInstanceOf(SemanticDownloadError);
    expect(String(error)).toContain("onnx/model.onnx");
    expect(String(error)).toContain("连接下载服务器");
    expect(String(error)).not.toContain("private=value");
  }
});

it("does not retry permanent HTTP errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("missing", { status: 404 })),
  );
  await expect(
    new HTTPSemanticArtifactSource().read(file)[Symbol.asyncIterator]().next(),
  ).rejects.toMatchObject({ retryable: false });
});
