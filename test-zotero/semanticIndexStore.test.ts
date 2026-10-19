import { SemanticIndexStore } from "../src/semantic/semanticIndexStore";
import { SemanticModelFingerprint } from "../src/semantic/types";
import { ZoteroSemanticDatabase } from "../src/semantic/zoteroSemanticDatabase";

describe("Phase 1A/1B Zotero semantic database", function () {
  it("round-trips Float32 BLOBs in an isolated plugin database", async function () {
    this.timeout(30000);
    const tempDirectory = String(
      (PathUtils as any).tempDir ||
        Services.dirsvc.get("TmpD", (Components as any).interfaces.nsIFile).path,
    );
    const databasePath = PathUtils.join(
      tempDirectory,
      `zaichat-semantic-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    let store: SemanticIndexStore | undefined;
    let stage = "open database";
    try {
      store = new SemanticIndexStore(await ZoteroSemanticDatabase.open(databasePath));
      stage = "initialize schema";
      await store.initialize();
      stage = "create generation";
      const generation = await store.createGeneration("paper", model());
      stage = "read generation";
      const reread = await store.getGeneration(generation.generationID);
      if (!reread) throw new Error("Created generation could not be read back");
      if (reread.state !== "building")
        throw new Error(`Created semantic generation has state ${reread.state}`);
      stage = "insert vector";
      await store.insertRecords(generation.generationID, [
        {
          namespace: "paper",
          recordID: "paper:1:TESTKEY1:title",
          recordType: "paper-metadata",
          sourceType: "zotero-item",
          sourceField: "title",
          libraryID: 1,
          itemKey: "TESTKEY1",
          sourceHash: "test-source",
          vector: new Float32Array([3, 4, 0]),
        },
      ]);
      stage = "activate generation";
      await store.activateGeneration(generation.generationID);
      stage = "search vector";
      const hits = await store.searchCosine("paper", new Float32Array([0.6, 0.8, 0]));
      if (hits.length !== 1 || Math.abs(hits[0].score - 1) > 1e-5)
        throw new Error(`Zotero semantic BLOB round-trip failed: ${hits[0]?.score}`);
      stage = "persist indexing job";
      const nextGeneration = await store.createGeneration("paper", model());
      const job = await store.createIndexJob(
        "paper",
        nextGeneration.generationID,
        model().fingerprint,
        [
          { libraryID: 1, itemKey: "REALKEY1" },
          { libraryID: 1, itemKey: "REALKEY2" },
        ],
      );
      await store.setIndexJobState(job.jobID, "running");
      const pending = await store.listPendingIndexJobItems(job.jobID, 10);
      if (pending.length !== 2 || pending[0].itemKey !== "REALKEY1")
        throw new Error("Zotero semantic indexing job did not persist item keys");
      const updated = await store.markIndexJobItemsCompleted(job.jobID, [
        pending[0].position,
      ]);
      if (updated.completedItems !== 1)
        throw new Error("Zotero semantic indexing checkpoint was not persisted");
    } catch (error) {
      throw {
        message: `Semantic integration failed during ${stage}`,
        expected: stage,
        actual:
          error instanceof Error
            ? `${error.message}\n${error.stack || ""}`
            : String(error),
      };
    } finally {
      await store?.close();
      for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`])
        await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });
});

function model(): SemanticModelFingerprint {
  return {
    modelID: "integration-test",
    version: "1",
    dimensions: 3,
    modelSHA256: "a".repeat(64),
    tokenizerSHA256: "b".repeat(64),
    pooling: "mean",
    normalization: "l2",
    fingerprint: "c".repeat(64),
  };
}
