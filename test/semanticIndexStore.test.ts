import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelFingerprint } from "../src/semantic/fingerprint";
import { SemanticIndexStore } from "../src/semantic/semanticIndexStore";
import { SemanticModelFingerprint, SemanticVectorRecord } from "../src/semantic/types";
import { NodeSemanticDatabase } from "./helpers/nodeSemanticDatabase";

describe("SemanticIndexStore", () => {
  let store: SemanticIndexStore;
  let model: SemanticModelFingerprint;

  beforeEach(async () => {
    store = new SemanticIndexStore(new NodeSemanticDatabase());
    model = await testModel();
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  it("inserts, updates, deletes, and cosine-searches active records", async () => {
    const generation = await store.createGeneration("paper", model);
    await store.insertRecords(generation.generationID, [
      record("title", [1, 0, 0]),
      record("abstract", [0, 1, 0]),
      record("tags", [0, 0, 1]),
    ]);
    const active = await store.activateGeneration(generation.generationID);
    expect(active.recordCount).toBe(3);
    expect(
      (await store.searchCosine("paper", new Float32Array([1, 0, 0]), 2))[0],
    ).toMatchObject({ sourceField: "title", score: 1 });

    await store.updateRecords(active.generationID, [record("title", [0, 1, 0])]);
    const updated = await store.listSourceRecords(active.generationID, 1, "ABCD1234");
    expect(updated).toHaveLength(3);
    expect(updated.find((entry) => entry.sourceField === "title")?.updatedAt).toBe(
      updated.find((entry) => entry.sourceField === "title")?.updatedAt,
    );

    expect(await store.deleteRecords(active.generationID, [recordID("tags")])).toBe(1);
    expect(await store.deleteSourceRecords(active.generationID, 1, "ABCD1234")).toBe(2);
    expect(await store.searchCosine("paper", new Float32Array([1, 0, 0]))).toEqual([]);
  });

  it("keeps the previous generation active until an atomic swap", async () => {
    const first = await store.createGeneration("paper", model);
    await store.insertRecords(first.generationID, [record("title", [1, 0, 0])]);
    await store.activateGeneration(first.generationID);

    const second = await store.createGeneration("paper", model);
    await store.insertRecords(second.generationID, [record("title", [0, 1, 0])]);
    expect((await store.getActiveGeneration("paper"))?.generationID).toBe(
      first.generationID,
    );
    await store.activateGeneration(second.generationID);
    expect((await store.getGeneration(first.generationID))?.state).toBe("retired");
    expect((await store.getActiveGeneration("paper"))?.generationID).toBe(
      second.generationID,
    );
  });

  it("supports independent active generations for separate namespaces", async () => {
    const paper = await store.createGeneration("paper", model);
    const future = await store.createGeneration("future-namespace", model);
    await store.activateGeneration(paper.generationID);
    await store.activateGeneration(future.generationID);
    expect((await store.getActiveGeneration("paper"))?.generationID).toBe(
      paper.generationID,
    );
    expect((await store.getActiveGeneration("future-namespace"))?.generationID).toBe(
      future.generationID,
    );
  });

  it("rejects dimension mismatches and missing update records", async () => {
    const generation = await store.createGeneration("paper", model);
    await expect(
      store.insertRecords(generation.generationID, [record("title", [1, 0])]),
    ).rejects.toThrow("expected 3");
    await expect(
      store.updateRecords(generation.generationID, [record("title", [1, 0, 0])]),
    ).rejects.toThrow("does not exist");
  });
});

async function testModel(): Promise<SemanticModelFingerprint> {
  return createModelFingerprint({
    modelID: "test-model",
    version: "1",
    dimensions: 3,
    modelSHA256: "a".repeat(64),
    tokenizerSHA256: "b".repeat(64),
    pooling: "mean",
    normalization: "l2",
  });
}

function record(field: string, values: number[]): SemanticVectorRecord {
  return {
    namespace: "paper",
    recordID: recordID(field),
    recordType: "paper-metadata",
    sourceType: "zotero-item",
    sourceField: field,
    libraryID: 1,
    itemKey: "ABCD1234",
    sourceHash: `${field}-hash`,
    vector: new Float32Array(values),
  };
}

function recordID(field: string): string {
  return `paper:1:ABCD1234:${field}`;
}
