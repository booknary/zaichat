import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelFingerprint } from "../src/semantic/fingerprint";
import {
  createSemanticStoreBenchmarkSearch,
  runSemanticRecallBenchmark,
} from "../src/semantic/semanticBenchmark";
import { SemanticIndexCoordinator } from "../src/semantic/semanticIndexCoordinator";
import { SemanticIndexStore } from "../src/semantic/semanticIndexStore";
import { SemanticRecordBuilder } from "../src/semantic/semanticRecordBuilder";
import { SemanticEmbeddingProvider } from "../src/semantic/types";
import { NodeSemanticDatabase } from "./helpers/nodeSemanticDatabase";

describe("paper semantic Recall@10 benchmark", () => {
  let store: SemanticIndexStore;

  beforeEach(async () => {
    store = new SemanticIndexStore(new NodeSemanticDatabase());
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  it("compares a lexical baseline with deduplicated semantic paper results", async () => {
    const embedding = new BenchmarkEmbeddingProvider();
    const model = await createModelFingerprint({
      modelID: "benchmark-model",
      version: "1",
      dimensions: 3,
      modelSHA256: "a".repeat(64),
      tokenizerSHA256: "b".repeat(64),
      pooling: "mean",
      normalization: "l2",
    });
    const coordinator = new SemanticIndexCoordinator(
      store,
      new SemanticRecordBuilder(),
      embedding,
      model,
    );
    await coordinator.rebuildPaperGeneration([
      {
        libraryID: 1,
        itemKey: "REALKEY1",
        title: "Cross-lingual scientific novelty",
        abstract: "The remembered target meaning",
        tags: ["target"],
      },
      {
        libraryID: 1,
        itemKey: "REALKEY2",
        title: "Unrelated control",
        abstract: "A lexical decoy",
        tags: ["control"],
      },
    ]);

    const report = await runSemanticRecallBenchmark(
      [
        {
          caseID: "cross-lingual-topic",
          query: "中文记忆中的目标含义",
          relevantItemKeys: ["REALKEY1"],
        },
      ],
      {
        async search() {
          return ["REALKEY2"];
        },
      },
      createSemanticStoreBenchmarkSearch(store, embedding, "paper"),
    );

    expect(report).toEqual({
      caseCount: 1,
      lexicalRecallAt10: 0,
      semanticRecallAt10: 1,
      cases: [
        {
          caseID: "cross-lingual-topic",
          lexicalRecallAt10: 0,
          semanticRecallAt10: 1,
        },
      ],
    });
  });
});

class BenchmarkEmbeddingProvider implements SemanticEmbeddingProvider {
  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) =>
      text.includes("target") || text.includes("novelty")
        ? new Float32Array([1, 0, 0])
        : new Float32Array([0, 1, 0]),
    );
  }

  async embedQuery(): Promise<Float32Array> {
    return new Float32Array([1, 0, 0]);
  }
}
