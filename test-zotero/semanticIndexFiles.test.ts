import { SemanticIndexFileManager } from "../src/semantic/semanticIndexFileManager";
import { ZoteroSemanticArtifactFileSystem } from "../src/semantic/zoteroSemanticArtifactFileSystem";

describe("Zotero semantic index file ownership", function () {
  it("tracks, clears, and deletes only its marked temporary root", async function () {
    this.timeout(30000);
    const fileSystem = new ZoteroSemanticArtifactFileSystem();
    const temporaryRoot = PathUtils.join(
      (PathUtils as any).tempDir || Services.dirsvc.get("TmpD", Ci.nsIFile).path,
      `zaichat-semantic-index-${Date.now()}`,
    );
    const manager = new SemanticIndexFileManager(
      fileSystem,
      temporaryRoot,
      "test-zotero",
    );
    try {
      await manager.prepare();
      await Zotero.File.putContentsAsync(manager.getDatabasePath(), "1234567");
      await Zotero.File.putContentsAsync(`${manager.getDatabasePath()}-wal`, "123");
      const installed = await manager.inspect();
      if (!installed.verified || !installed.installed || installed.diskUsage !== 10)
        throw new Error(
          `Unexpected semantic index status: ${JSON.stringify(installed)}`,
        );

      await manager.clear(true);
      const cleared = await manager.inspect();
      if (!cleared.verified || cleared.installed || cleared.diskUsage !== 0)
        throw new Error(`Semantic index was not cleared: ${JSON.stringify(cleared)}`);

      await manager.deleteAll(true);
      if (await IOUtils.exists(temporaryRoot))
        throw new Error("Semantic index root was not deleted");
    } finally {
      await IOUtils.remove(temporaryRoot, { recursive: true, ignoreAbsent: true });
    }
  });
});
