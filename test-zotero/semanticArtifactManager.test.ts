import { SemanticArtifactManager } from "../src/semantic/semanticArtifactManager";
import { ZoteroSemanticArtifactFileSystem } from "../src/semantic/zoteroSemanticArtifactFileSystem";

describe("Zotero semantic artifact file system", function () {
  it("streams, verifies, inspects, and safely deletes a managed artifact", async function () {
    this.timeout(30000);
    const fileSystem = new ZoteroSemanticArtifactFileSystem();
    const temporaryRoot = PathUtils.join(
      (PathUtils as any).tempDir || Services.dirsvc.get("TmpD", Ci.nsIFile).path,
      `zaichat-semantic-artifact-${Date.now()}`,
    );
    const bytes = new TextEncoder().encode("ZaiChat semantic artifact fixture");
    const digest = await digestHex(bytes);
    const manifest = {
      formatVersion: 1 as const,
      packageType: "model" as const,
      packageID: "fixture/model",
      version: "1",
      platform: "win-x64" as const,
      files: [
        {
          relativePath: "onnx/model.bin",
          size: bytes.byteLength,
          sha256: digest,
          url: "https://models.example.invalid/model.bin",
        },
      ],
    };
    const manager = new SemanticArtifactManager(
      fileSystem,
      temporaryRoot,
      "test-zotero",
    );
    try {
      const status = await manager.install(
        manifest,
        {
          async *read() {
            yield bytes.slice(0, 7);
            yield bytes.slice(7);
          },
        },
        { confirmed: true },
      );
      if (!status.verified || status.diskUsage !== bytes.byteLength)
        throw new Error(`Unexpected artifact status: ${JSON.stringify(status)}`);
      await manager.delete(manifest, true);
      const deleted = await manager.inspect(manifest);
      if (deleted.installed) throw new Error("Managed artifact was not deleted");
    } finally {
      await IOUtils.remove(temporaryRoot, { recursive: true, ignoreAbsent: true });
    }
  });
});

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
