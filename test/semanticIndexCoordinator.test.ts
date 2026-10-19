import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelFingerprint } from "../src/semantic/fingerprint";
import { SemanticIndexCoordinator } from "../src/semantic/semanticIndexCoordinator";
import { SemanticIndexStore } from "../src/semantic/semanticIndexStore";
import { SemanticRecordBuilder } from "../src/semantic/semanticRecordBuilder";
import {
  PaperSemanticSource,
  SemanticEmbeddingProvider,
  SemanticModelFingerprint,
} from "../src/semantic/types";
import { NodeSemanticDatabase } from "./helpers/nodeSemanticDatabase";

describe("SemanticIndexCoordinator", () => {
  let store: SemanticIndexStore;
  let model: SemanticModelFingerprint;
  let embedder: DeterministicEmbeddingProvider;
  let coordinator: SemanticIndexCoordinator;

  beforeEach(async () => {
    store = new SemanticIndexStore(new NodeSemanticDatabase());
    await store.initialize();
    model = await createModelFingerprint({
      modelID: "test-model",
      version: "1",
      dimensions: 3,
      modelSHA256: "a".repeat(64),
      tokenizerSHA256: "b".repeat(64),
      pooling: "mean",
      normalization: "l2",
    });
    embedder = new DeterministicEmbeddingProvider();
    coordinator = new SemanticIndexCoordinator(
      store,
      new SemanticRecordBuilder(),
      embedder,
      model,
    );
  });

  afterEach(async () => {
    await store.close();
  });

  it("rebuilds paper metadata and embeds only changed fields later", async () => {
    const source = paper();
    const active = await coordinator.rebuildPaperGeneration([source], 2);
    expect(active.state).toBe("active");
    expect(active.recordCount).toBe(3);
    expect(embedder.inputs).toHaveLength(3);

    embedder.inputs = [];
    expect(await coordinator.indexPaper(source)).toEqual({
      inserted: 0,
      updated: 0,
      deleted: 0,
      skipped: 3,
    });
    expect(embedder.inputs).toEqual([]);

    const changed = { ...source, abstract: "A changed abstract" };
    expect(await coordinator.indexPaper(changed)).toEqual({
      inserted: 0,
      updated: 1,
      deleted: 0,
      skipped: 2,
    });
    expect(embedder.inputs).toEqual(["Abstract: A changed abstract"]);

    embedder.inputs = [];
    expect(await coordinator.indexPaper({ ...changed, tags: [] })).toEqual({
      inserted: 0,
      updated: 0,
      deleted: 1,
      skipped: 2,
    });
    expect(await coordinator.deletePaper(1, "ABCD1234")).toBe(2);
  });

  it("reuses equal fields across item keys without dropping distinct references", async () => {
    const source = paper();
    const active = await coordinator.rebuildPaperGeneration([source]);
    embedder.inputs = [];
    const duplicate = { ...source, itemKey: "DUPL0001" };
    await coordinator.indexPaper(duplicate);
    expect(embedder.inputs).toEqual([]);
    expect(
      await store.listSourceRecords(
        active.generationID,
        duplicate.libraryID,
        duplicate.itemKey,
      ),
    ).toHaveLength(3);
    await coordinator.indexPaper({
      ...duplicate,
      abstract: "New evidence not in the other item",
    });
    expect(embedder.inputs).toEqual(["Abstract: New evidence not in the other item"]);
  });

  it("leaves the active generation untouched when a rebuild fails", async () => {
    const first = await coordinator.rebuildPaperGeneration([paper()]);
    const failing = new SemanticIndexCoordinator(
      store,
      new SemanticRecordBuilder(),
      {
        async embedDocuments() {
          throw new Error("embedding failed");
        },
        async embedQuery() {
          throw new Error("embedding failed");
        },
      },
      model,
    );
    await expect(failing.rebuildPaperGeneration([paper()])).rejects.toThrow(
      "embedding failed",
    );
    expect((await store.getActiveGeneration("paper"))?.generationID).toBe(
      first.generationID,
    );
  });

  it("uses an injected source provider without reading notes or annotations", async () => {
    const source = paper();
    const provider = {
      async listPapers() {
        return [source];
      },
      async listPaperRefs() {
        return [{ libraryID: source.libraryID, itemKey: source.itemKey }];
      },
      async getPaper() {
        return source;
      },
      async getPaperRefByItemID() {
        return { libraryID: source.libraryID, itemKey: source.itemKey };
      },
    };
    const withProvider = new SemanticIndexCoordinator(
      store,
      new SemanticRecordBuilder(),
      embedder,
      model,
      provider,
    );
    await withProvider.rebuildPaperGeneration();
    expect(await withProvider.indexPaperByRef(1, "ABCD1234")).toMatchObject({
      skipped: 3,
    });
  });
});

class DeterministicEmbeddingProvider implements SemanticEmbeddingProvider {
  inputs: string[] = [];

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    this.inputs.push(...texts);
    return texts.map((text) => {
      if (text.startsWith("Title:")) return new Float32Array([1, 0, 0]);
      if (text.startsWith("Abstract:")) return new Float32Array([0, 1, 0]);
      return new Float32Array([0, 0, 1]);
    });
  }

  async embedQuery(): Promise<Float32Array> {
    return new Float32Array([1, 0, 0]);
  }
}

function paper(): PaperSemanticSource {
  return {
    libraryID: 1,
    itemKey: "ABCD1234",
    title: "Genome novelty",
    abstract: "Two waves of innovation",
    tags: ["evolution"],
  };
}
