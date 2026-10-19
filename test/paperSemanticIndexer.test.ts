import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelFingerprint } from "../src/semantic/fingerprint";
import { PaperSemanticIndexer } from "../src/semantic/paperSemanticIndexer";
import { SemanticIndexCoordinator } from "../src/semantic/semanticIndexCoordinator";
import { SemanticIndexStore } from "../src/semantic/semanticIndexStore";
import { SemanticRecordBuilder } from "../src/semantic/semanticRecordBuilder";
import {
  PaperIndexProgress,
  PaperSemanticRef,
  PaperSemanticSource,
  PaperSemanticSourceProvider,
  SemanticEmbeddingProvider,
  SemanticModelFingerprint,
} from "../src/semantic/types";
import { ZoteroPaperIndexNotifier } from "../src/semantic/zoteroPaperIndexNotifier";
import { NodeSemanticDatabase } from "./helpers/nodeSemanticDatabase";

describe("PaperSemanticIndexer", () => {
  let store: SemanticIndexStore;
  let model: SemanticModelFingerprint;
  let embedder: RecordingEmbeddingProvider;
  let provider: MutablePaperProvider;
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
    embedder = new RecordingEmbeddingProvider();
    provider = new MutablePaperProvider([paper("ABCD1234"), paper("EFGH5678")]);
    coordinator = new SemanticIndexCoordinator(
      store,
      new SemanticRecordBuilder(),
      embedder,
      model,
      provider,
    );
  });

  afterEach(async () => {
    await store.close();
  });

  it("indexes an existing library with progress and supports pause/resume", async () => {
    const indexer = createIndexer();
    await indexer.initialize();
    const progress: PaperIndexProgress[] = [];
    indexer.subscribe((value) => progress.push(value));

    const oneCompleted = waitForProgress(
      indexer,
      (value) => value.completedItems === 1,
    );
    const run = indexer.rebuild();
    await oneCompleted;
    await indexer.pause();
    expect(indexer.getProgress()).toMatchObject({
      state: "paused",
      completedItems: 1,
      totalItems: 2,
    });

    const resumed = indexer.resume();
    const active = await resumed;
    expect(await run).toEqual(active);
    expect(active?.recordCount).toBe(6);
    expect(indexer.getProgress()).toMatchObject({
      state: "completed",
      completedItems: 2,
      vectorCount: 6,
    });
    expect(progress.some((value) => value.state === "running")).toBe(true);
  });

  it("cancels a paused rebuild without replacing the active generation", async () => {
    const first = createIndexer();
    const oldActive = await first.rebuild();
    provider.put(paper("IJKL9012"));
    const second = createIndexer();
    const oneCompleted = waitForProgress(second, (value) => value.completedItems === 1);
    const run = second.rebuild();
    await oneCompleted;
    await second.pause();
    await second.cancel();

    expect(await run).toBeNull();
    expect(second.getProgress().state).toBe("cancelled");
    expect((await store.getActiveGeneration("paper"))?.generationID).toBe(
      oldActive?.generationID,
    );
  });

  it("synchronizes new, modified, and deleted papers from notifier events", async () => {
    const indexer = createIndexer();
    await indexer.rebuild();
    embedder.inputs = [];
    const added = paper("IJKL9012");
    provider.put(added, 42);
    const notifier = new ZoteroPaperIndexNotifier(indexer, provider, {
      debounceMs: 0,
      notifier: fakeNotifier(),
      userLibraryID: 1,
    });

    await notifier.notify("add", "item", [42]);
    await notifier.flush();
    let active = await store.getActiveGeneration("paper");
    expect(
      await store.listSourceRecords(active!.generationID, 1, added.itemKey),
    ).toHaveLength(3);

    embedder.inputs = [];
    provider.put({ ...added, abstract: "A changed abstract" }, 42);
    await notifier.notify("modify", "item", [42]);
    await notifier.flush();
    expect(embedder.inputs).toEqual(["Abstract: A changed abstract"]);

    embedder.inputs = [];
    provider.put(
      { ...added, title: "A changed title", abstract: "A changed abstract" },
      42,
    );
    await notifier.notify("modify", "item", [42]);
    await notifier.flush();
    expect(embedder.inputs).toEqual(["Title: A changed title"]);

    provider.remove(added.itemKey);
    await notifier.notify("delete", "item", [42], {
      42: { libraryID: 1, key: added.itemKey },
    });
    await notifier.flush();
    active = await store.getActiveGeneration("paper");
    expect(
      await store.listSourceRecords(active!.generationID, 1, added.itemKey),
    ).toEqual([]);
  });

  it("registers and unregisters exactly one Zotero item observer", () => {
    const indexer = createIndexer();
    const calls = { registered: 0, unregistered: 0 };
    const notifier = new ZoteroPaperIndexNotifier(indexer, provider, {
      notifier: {
        registerObserver(_observer, types) {
          calls.registered += 1;
          expect(types).toEqual(["item"]);
          return "observer-id";
        },
        unregisterObserver(id) {
          calls.unregistered += 1;
          expect(id).toBe("observer-id");
        },
      },
      userLibraryID: 1,
    });
    notifier.register();
    notifier.register();
    notifier.unregister();
    notifier.unregister();
    expect(calls).toEqual({ registered: 1, unregistered: 1 });
  });

  it("recovers an interrupted job and resumes only pending real item keys", async () => {
    const generation = await store.createGeneration("paper", model);
    let job = await store.createIndexJob(
      "paper",
      generation.generationID,
      model.fingerprint,
      await provider.listPaperRefs(),
    );
    job = await store.setIndexJobState(job.jobID, "running");
    const firstRef = (await store.listPendingIndexJobItems(job.jobID, 1))[0];
    const firstPaper = await provider.getPaper(firstRef.libraryID, firstRef.itemKey);
    await coordinator.replacePaperInGeneration(job.generationID, firstPaper!);
    await store.markIndexJobItemsCompleted(job.jobID, [firstRef.position]);
    embedder.inputs = [];

    const recovered = createIndexer();
    expect(await recovered.initialize()).toMatchObject({
      state: "paused",
      completedItems: 1,
      recovered: true,
    });
    const active = await recovered.resume();

    expect(active?.recordCount).toBe(6);
    expect(recovered.getProgress()).toMatchObject({
      state: "completed",
      completedItems: 2,
      recovered: true,
    });
    expect(embedder.inputs).toHaveLength(3);
    expect(embedder.inputs.join(" ")).toContain("EFGH5678");
  });

  it("reconciles offline additions and deletions on startup without rebuilding", async () => {
    const first = createIndexer();
    await first.initialize();
    const generation = await first.ensureInitialIndex();
    await first.shutdown();
    provider.remove("EFGH5678");
    provider.put(paper("NEWP1234"));
    embedder.inputs = [];
    const restarted = createIndexer();
    await restarted.initialize();
    const active = await restarted.ensureInitialIndex();
    expect(active.generationID).toBe(generation.generationID);
    expect(embedder.inputs).toHaveLength(3);
    expect(embedder.inputs.join(" ")).toContain("NEWP1234");
    expect(await store.listSourceRecords(active.generationID, 1, "EFGH5678")).toEqual(
      [],
    );
    embedder.inputs = [];
    await Promise.all([
      restarted.synchronizePaper({ libraryID: 1, itemKey: "NEWP1234" }),
      restarted.synchronizePaper({ libraryID: 1, itemKey: "NEWP1234" }),
    ]);
    expect(embedder.inputs).toEqual([]);
  });

  it("shuts down without failing the generation and resumes it after restart", async () => {
    const indexer = createIndexer();
    const oneCompleted = waitForProgress(
      indexer,
      (value) => value.completedItems === 1,
    );
    const run = indexer.rebuild();
    await oneCompleted;
    await indexer.shutdown();

    expect(await run).toBeNull();
    expect(indexer.getProgress()).toMatchObject({
      state: "paused",
      completedItems: 1,
    });
    const generation = await store.getGeneration(indexer.getProgress().generationID!);
    expect(generation?.state).toBe("building");

    const restarted = createIndexer();
    expect(await restarted.initialize()).toMatchObject({
      state: "paused",
      completedItems: 1,
      recovered: true,
    });
    expect((await restarted.resume())?.recordCount).toBe(6);
  });

  function createIndexer(): PaperSemanticIndexer {
    return new PaperSemanticIndexer(store, coordinator, provider, model, {
      batchSize: 1,
      yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
    });
  }
});

class RecordingEmbeddingProvider implements SemanticEmbeddingProvider {
  inputs: string[] = [];

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    this.inputs.push(...texts);
    return texts.map((text) => vectorFor(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return vectorFor(text);
  }
}

class MutablePaperProvider implements PaperSemanticSourceProvider {
  private readonly papers = new Map<string, PaperSemanticSource>();
  private readonly itemIDs = new Map<number, PaperSemanticRef>();

  constructor(papers: PaperSemanticSource[]) {
    for (const source of papers) this.put(source);
  }

  put(source: PaperSemanticSource, itemID?: number): void {
    this.papers.set(source.itemKey, source);
    if (itemID) this.itemIDs.set(itemID, ref(source));
  }

  remove(itemKey: string): void {
    this.papers.delete(itemKey);
  }

  async listPapers(): Promise<PaperSemanticSource[]> {
    return [...this.papers.values()];
  }

  async listPaperRefs(): Promise<PaperSemanticRef[]> {
    return [...this.papers.values()].map(ref);
  }

  async getPaper(
    libraryID: number,
    itemKey: string,
  ): Promise<PaperSemanticSource | null> {
    const source = this.papers.get(itemKey);
    return source?.libraryID === libraryID ? source : null;
  }

  async getPaperRefByItemID(itemID: number): Promise<PaperSemanticRef | null> {
    return this.itemIDs.get(itemID) || null;
  }
}

function paper(itemKey: string): PaperSemanticSource {
  return {
    libraryID: 1,
    itemKey,
    title: `Title ${itemKey}`,
    abstract: `Abstract ${itemKey}`,
    tags: [`tag-${itemKey}`],
  };
}

function ref(source: PaperSemanticSource): PaperSemanticRef {
  return { libraryID: source.libraryID, itemKey: source.itemKey };
}

function vectorFor(text: string): Float32Array {
  if (text.startsWith("Title:")) return new Float32Array([1, 0, 0]);
  if (text.startsWith("Abstract:")) return new Float32Array([0, 1, 0]);
  return new Float32Array([0, 0, 1]);
}

function waitForProgress(
  indexer: PaperSemanticIndexer,
  predicate: (progress: PaperIndexProgress) => boolean,
): Promise<PaperIndexProgress> {
  return new Promise((resolve) => {
    const unsubscribe = indexer.subscribe((progress) => {
      if (!predicate(progress)) return;
      unsubscribe();
      resolve(progress);
    });
  });
}

function fakeNotifier() {
  return {
    registerObserver() {
      return "observer-id";
    },
    unregisterObserver() {},
  };
}
