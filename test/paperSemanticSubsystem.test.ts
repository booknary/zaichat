import { beforeEach, describe, expect, it } from "vitest";
import { createModelFingerprint } from "../src/semantic/fingerprint";
import {
  PaperSemanticSubsystem,
  PaperSemanticSubsystemStatus,
} from "../src/semantic/paperSemanticSubsystem";
import { SemanticRuntimeAvailability } from "../src/semantic/semanticRuntimeFactory";
import { EmbeddingRuntimeStatus } from "../src/semantic/runtimeTypes";
import {
  PaperSemanticRef,
  PaperSemanticSource,
  PaperSemanticSourceProvider,
  SemanticDatabase,
  SemanticEmbeddingProvider,
  SemanticModelFingerprint,
  SemanticSqlValue,
} from "../src/semantic/types";
import { NodeSemanticDatabase } from "./helpers/nodeSemanticDatabase";

describe("PaperSemanticSubsystem", () => {
  let model: SemanticModelFingerprint;

  beforeEach(async () => {
    model = await createModelFingerprint({
      modelID: "test-model",
      version: "1",
      dimensions: 3,
      modelSHA256: "a".repeat(64),
      tokenizerSHA256: "b".repeat(64),
      pooling: "mean",
      normalization: "l2",
    });
  });

  it("stays unavailable without opening SQLite or starting a worker", async () => {
    let opens = 0;
    let creates = 0;
    const subsystem = createSubsystem({
      availability: unavailable(),
      onOpen: () => (opens += 1),
      onCreate: () => (creates += 1),
    });

    expect(await subsystem.start()).toMatchObject({
      state: "unavailable",
      failure: "Embedding runtime is not installed",
    });
    expect({ opens, creates }).toEqual({ opens: 0, creates: 0 });
    await subsystem.stop();
    expect(subsystem.getStatus()).toEqual({ state: "stopped" });
  });

  it("rejects a model fingerprint that differs from the runtime factory", async () => {
    let opens = 0;
    let creates = 0;
    const errors: Error[] = [];
    const subsystem = createSubsystem({
      runtimeModel: { ...model, fingerprint: "f".repeat(64) },
      errors,
      onOpen: () => (opens += 1),
      onCreate: () => (creates += 1),
    });

    expect(await subsystem.start()).toMatchObject({
      state: "failed",
      failure: "Semantic subsystem model does not match its runtime factory",
    });
    expect({ opens, creates, errors: errors.length }).toEqual({
      opens: 0,
      creates: 0,
      errors: 1,
    });
  });

  it("wires verified artifacts through indexing and closes every resource", async () => {
    const runtime = new FakeRuntime();
    const database = new CountingDatabase();
    const notifier = new FakeNotifier();
    const subsystem = createSubsystem({ runtime, database, notifier });
    const states: PaperSemanticSubsystemStatus["state"][] = [];
    subsystem.subscribe((status) => states.push(status.state));

    await subsystem.start();
    await subsystem.waitForIndexing();

    expect(subsystem.getStatus()).toMatchObject({
      state: "ready",
      indexing: { state: "completed", vectorCount: 6 },
    });
    expect(runtime.documentCount).toBe(6);
    expect(notifier.registered).toBe(1);
    expect(states).toContain("indexing");
    const hits = await subsystem.searchPapers("find the tagged papers", 10);
    expect(hits).toHaveLength(2);
    expect(hits[0].sourceFields).toEqual(["tags"]);

    await subsystem.stop();
    expect(notifier.unregistered).toBe(1);
    expect(runtime.stopped).toBe(1);
    expect(database.closed).toBe(1);
    expect(subsystem.getStatus()).toEqual({ state: "stopped" });
  });

  it("reports background embedding failures without throwing from startup", async () => {
    const runtime = new FakeRuntime(true);
    const errors: Error[] = [];
    const subsystem = createSubsystem({ runtime, errors });

    expect((await subsystem.start()).state).toBe("indexing");
    await subsystem.waitForIndexing();

    expect(subsystem.getStatus()).toMatchObject({
      state: "failed",
      failure: "synthetic embedding failure",
    });
    expect(errors).toHaveLength(1);
    await subsystem.stop();
  });

  it("persists a recoverable paused job when stopped during indexing", async () => {
    const runtime = new FakeRuntime(false, 15);
    const database = new CountingDatabase();
    const subsystem = createSubsystem({
      runtime,
      database,
      sourceProvider: new FakePaperProvider(4),
    });
    const oneCompleted = waitForStatus(
      subsystem,
      (status) => status.indexing?.completedItems === 1,
    );

    await subsystem.start();
    await oneCompleted;
    await subsystem.stop();

    expect(database.jobStates).toEqual(["paused"]);
    expect(database.generationStates).toEqual(["building"]);
    expect(subsystem.getStatus()).toEqual({ state: "stopped" });
  });

  function createSubsystem(
    options: {
      availability?: SemanticRuntimeAvailability;
      runtime?: FakeRuntime;
      database?: CountingDatabase;
      notifier?: FakeNotifier;
      errors?: Error[];
      sourceProvider?: PaperSemanticSourceProvider;
      runtimeModel?: SemanticModelFingerprint;
      onOpen?: () => void;
      onCreate?: () => void;
    } = {},
  ): PaperSemanticSubsystem {
    const runtime = options.runtime || new FakeRuntime();
    const database = options.database || new CountingDatabase();
    const notifier = options.notifier || new FakeNotifier();
    return new PaperSemanticSubsystem({
      runtimeFactory: {
        inspect: async () => options.availability || available(),
        getModelFingerprint: () => options.runtimeModel || model,
        create: async () => {
          options.onCreate?.();
          return runtime;
        },
      },
      model,
      sourceProvider: options.sourceProvider || new FakePaperProvider(),
      openDatabase: async () => {
        options.onOpen?.();
        return database;
      },
      createNotifier: () => notifier,
      onError: (error) => options.errors?.push(error),
    });
  }
});

class FakeRuntime implements SemanticEmbeddingProvider {
  documentCount = 0;
  stopped = 0;
  private readonly listeners = new Set<(status: EmbeddingRuntimeStatus) => void>();

  constructor(
    private readonly fail = false,
    private readonly delayMs = 0,
  ) {}

  getStatus(): EmbeddingRuntimeStatus {
    return { state: "stopped", crashCount: 0 };
  }

  subscribe(listener: (status: EmbeddingRuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (this.fail) throw new Error("synthetic embedding failure");
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.documentCount += texts.length;
    return texts.map(vectorFor);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return vectorFor(text);
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

class FakePaperProvider implements PaperSemanticSourceProvider {
  private readonly papers: PaperSemanticSource[];

  constructor(count = 2) {
    this.papers = Array.from({ length: count }, (_value, index) =>
      paper(`ITEM${String(index).padStart(4, "0")}`),
    );
  }

  async listPapers(): Promise<PaperSemanticSource[]> {
    return [...this.papers];
  }

  async listPaperRefs(): Promise<PaperSemanticRef[]> {
    return this.papers.map(({ libraryID, itemKey }) => ({ libraryID, itemKey }));
  }

  async getPaper(
    libraryID: number,
    itemKey: string,
  ): Promise<PaperSemanticSource | null> {
    return (
      this.papers.find(
        (source) => source.libraryID === libraryID && source.itemKey === itemKey,
      ) || null
    );
  }

  async getPaperRefByItemID(): Promise<PaperSemanticRef | null> {
    return null;
  }
}

class FakeNotifier {
  registered = 0;
  unregistered = 0;

  register(): void {
    this.registered += 1;
  }

  unregister(): void {
    this.unregistered += 1;
  }
}

class CountingDatabase implements SemanticDatabase {
  private readonly database = new NodeSemanticDatabase();
  closed = 0;
  jobStates: string[] = [];
  generationStates: string[] = [];

  execute(sql: string, params?: SemanticSqlValue[]): Promise<void> {
    return this.database.execute(sql, params);
  }

  query<T extends Record<string, unknown>>(
    sql: string,
    params?: SemanticSqlValue[],
  ): Promise<T[]> {
    return this.database.query<T>(sql, params);
  }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.database.transaction(operation);
  }

  async close(): Promise<void> {
    this.closed += 1;
    this.jobStates = (
      await this.database.query<{ state: string }>(
        "SELECT state FROM semantic_index_jobs ORDER BY created_at",
      )
    ).map(({ state }) => state);
    this.generationStates = (
      await this.database.query<{ state: string }>(
        "SELECT state FROM semantic_generations ORDER BY created_at",
      )
    ).map(({ state }) => state);
    await this.database.close();
  }
}

function available(): SemanticRuntimeAvailability {
  return {
    available: true,
    runtime: artifactStatus(true),
    model: artifactStatus(true),
  };
}

function unavailable(): SemanticRuntimeAvailability {
  return {
    available: false,
    runtime: artifactStatus(false),
    model: artifactStatus(false),
    failure: "Embedding runtime is not installed",
  };
}

function artifactStatus(verified: boolean) {
  return {
    installed: verified,
    verified,
    location: "C:\\semantic-test",
    expectedSize: 1,
    diskUsage: verified ? 1 : 0,
  };
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

function vectorFor(text: string): Float32Array {
  if (text.startsWith("Title:")) return new Float32Array([1, 0, 0]);
  if (text.startsWith("Abstract:")) return new Float32Array([0, 1, 0]);
  return new Float32Array([0, 0, 1]);
}

function waitForStatus(
  subsystem: PaperSemanticSubsystem,
  predicate: (status: PaperSemanticSubsystemStatus) => boolean,
): Promise<PaperSemanticSubsystemStatus> {
  return new Promise((resolve) => {
    const unsubscribe = subsystem.subscribe((status) => {
      if (!predicate(status)) return;
      unsubscribe();
      resolve(status);
    });
  });
}
