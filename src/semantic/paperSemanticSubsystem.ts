import { PaperSemanticIndexer } from "./paperSemanticIndexer";
import { SemanticIndexCoordinator } from "./semanticIndexCoordinator";
import { SemanticIndexFileManager } from "./semanticIndexFileManager";
import { SemanticIndexStore } from "./semanticIndexStore";
import { SemanticRecordBuilder } from "./semanticRecordBuilder";
import {
  SemanticRuntimeAvailability,
  SemanticRuntimeFactory,
} from "./semanticRuntimeFactory";
import { EmbeddingRuntimeStatus } from "./runtimeTypes";
import {
  PaperIndexProgress,
  PAPER_NAMESPACE,
  PaperSemanticSearchResult,
  PaperSemanticSourceProvider,
  SemanticDatabase,
  SemanticEmbeddingProvider,
  SemanticModelFingerprint,
} from "./types";
import { ZoteroPaperIndexNotifier } from "./zoteroPaperIndexNotifier";
import { ZoteroPaperSourceProvider } from "./zoteroPaperSourceProvider";
import { ZoteroSemanticArtifactFileSystem } from "./zoteroSemanticArtifactFileSystem";
import { ZoteroSemanticDatabase } from "./zoteroSemanticDatabase";

export type PaperSemanticSubsystemState =
  | "stopped"
  | "checking"
  | "unavailable"
  | "starting"
  | "indexing"
  | "paused"
  | "ready"
  | "failed";

export interface PaperSemanticSubsystemStatus {
  state: PaperSemanticSubsystemState;
  availability?: SemanticRuntimeAvailability;
  runtime?: EmbeddingRuntimeStatus;
  indexing?: PaperIndexProgress;
  failure?: string;
}

interface SemanticRuntimeFactoryLike {
  inspect(): Promise<SemanticRuntimeAvailability>;
  create(): Promise<SemanticRuntimeController>;
  getModelFingerprint?(): SemanticModelFingerprint;
}

interface SemanticRuntimeController extends SemanticEmbeddingProvider {
  getStatus(): EmbeddingRuntimeStatus;
  subscribe(listener: (status: EmbeddingRuntimeStatus) => void): () => void;
  stop(): Promise<void>;
}

interface PaperIndexNotifierLike {
  register(): void;
  unregister(): void;
}

export interface PaperSemanticSubsystemDependencies {
  runtimeFactory: SemanticRuntimeFactoryLike;
  model: SemanticModelFingerprint;
  sourceProvider: PaperSemanticSourceProvider;
  openDatabase: () => Promise<SemanticDatabase>;
  createNotifier: (
    indexer: PaperSemanticIndexer,
    sourceProvider: PaperSemanticSourceProvider,
  ) => PaperIndexNotifierLike;
  onError?: (error: Error) => void;
}

export class PaperSemanticSubsystem {
  private status: PaperSemanticSubsystemStatus = { state: "stopped" };
  private readonly listeners = new Set<
    (status: PaperSemanticSubsystemStatus) => void
  >();
  private readonly onError: (error: Error) => void;
  private startPromise?: Promise<PaperSemanticSubsystemStatus>;
  private indexTask?: Promise<void>;
  private lifecycleToken = 0;
  private runtime?: SemanticRuntimeController;
  private store?: SemanticIndexStore;
  private indexer?: PaperSemanticIndexer;
  private notifier?: PaperIndexNotifierLike;
  private unsubscribeRuntime?: () => void;
  private unsubscribeIndex?: () => void;

  constructor(private readonly dependencies: PaperSemanticSubsystemDependencies) {
    this.onError = dependencies.onError || (() => undefined);
  }

  getStatus(): PaperSemanticSubsystemStatus {
    return cloneStatus(this.status);
  }

  subscribe(listener: (status: PaperSemanticSubsystemStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<PaperSemanticSubsystemStatus> {
    if (this.store) return this.getStatus();
    if (this.startPromise) return this.startPromise;
    const token = ++this.lifecycleToken;
    const start = this.startInternal(token).finally(() => {
      if (this.startPromise === start) this.startPromise = undefined;
    });
    this.startPromise = start;
    return start;
  }

  async waitForIndexing(): Promise<void> {
    await this.indexTask;
  }

  async pauseIndexing(): Promise<void> {
    await this.indexer?.pause();
  }

  async resumeIndexing(): Promise<void> {
    if (!this.indexer) throw new Error("Paper semantic subsystem is not started");
    const operation = this.indexer.resume();
    if (!this.indexTask) this.startIndexTask(operation);
  }

  async cancelIndexing(): Promise<void> {
    await this.indexer?.cancel();
  }

  async rebuildIndex(): Promise<void> {
    if (!this.indexer) throw new Error("Paper semantic subsystem is not started");
    this.startIndexTask(this.indexer.rebuild());
  }

  async searchPapers(query: string, limit = 30): Promise<PaperSemanticSearchResult[]> {
    if (!query.trim() || !this.runtime || !this.store) return [];
    const active = await this.store.getActiveGeneration(PAPER_NAMESPACE);
    if (!active || active.model.fingerprint !== this.dependencies.model.fingerprint)
      return [];
    const vector = await this.runtime.embedQuery(query);
    const hits = await this.store.searchCosine(
      PAPER_NAMESPACE,
      vector,
      Math.min(300, Math.max(limit * 3, limit)),
    );
    const grouped = new Map<string, PaperSemanticSearchResult>();
    for (const hit of hits) {
      const key = `${hit.libraryID}:${hit.itemKey}`;
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          libraryID: hit.libraryID,
          itemKey: hit.itemKey,
          score: hit.score,
          sourceFields: [
            hit.sourceField as PaperSemanticSearchResult["sourceFields"][number],
          ],
        });
        continue;
      }
      const field =
        hit.sourceField as PaperSemanticSearchResult["sourceFields"][number];
      if (hit.score > existing.score + 0.015) {
        existing.score = hit.score;
        existing.sourceFields = [field];
      } else if (
        Math.abs(hit.score - existing.score) <= 0.015 &&
        !existing.sourceFields.includes(field)
      )
        existing.sourceFields.push(field);
    }
    return [...grouped.values()]
      .sort(
        (left, right) =>
          right.score - left.score || left.itemKey.localeCompare(right.itemKey),
      )
      .slice(0, Math.min(100, Math.max(1, limit)));
  }

  async stop(): Promise<void> {
    ++this.lifecycleToken;
    await this.startPromise?.catch(() => undefined);
    this.notifier?.unregister();
    this.notifier = undefined;
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = undefined;
    await this.indexer?.shutdown();
    await this.indexTask?.catch(() => undefined);
    this.indexTask = undefined;
    this.indexer = undefined;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = undefined;
    await this.runtime?.stop();
    this.runtime = undefined;
    await this.store?.close();
    this.store = undefined;
    this.setStatus({ state: "stopped" });
  }

  private async startInternal(token: number): Promise<PaperSemanticSubsystemStatus> {
    this.setStatus({ state: "checking" });
    let availability: SemanticRuntimeAvailability;
    try {
      const runtimeModel = this.dependencies.runtimeFactory.getModelFingerprint?.();
      if (
        runtimeModel &&
        runtimeModel.fingerprint !== this.dependencies.model.fingerprint
      )
        throw new Error("Semantic subsystem model does not match its runtime factory");
      availability = await this.dependencies.runtimeFactory.inspect();
    } catch (error) {
      const failure = safeError(error);
      this.setStatus({ state: "failed", failure });
      this.onError(error instanceof Error ? error : new Error(failure));
      return this.getStatus();
    }
    if (token !== this.lifecycleToken) return this.getStatus();
    if (!availability.available) {
      this.setStatus({
        state: "unavailable",
        availability,
        failure: availability.failure || "Semantic artifacts are unavailable",
      });
      return this.getStatus();
    }
    this.setStatus({ state: "starting", availability });
    try {
      this.runtime = await this.dependencies.runtimeFactory.create();
      this.store = new SemanticIndexStore(await this.dependencies.openDatabase());
      await this.store.initialize();
      if (token !== this.lifecycleToken) {
        await this.cleanupFailedStart();
        return this.getStatus();
      }
      const runtime = this.runtime;
      const store = this.store;
      const sourceProvider = this.dependencies.sourceProvider;
      const coordinator = new SemanticIndexCoordinator(
        store,
        new SemanticRecordBuilder(),
        runtime,
        this.dependencies.model,
        sourceProvider,
      );
      const indexer = new PaperSemanticIndexer(
        store,
        coordinator,
        sourceProvider,
        this.dependencies.model,
      );
      await indexer.initialize();
      const notifier = this.dependencies.createNotifier(indexer, sourceProvider);
      this.runtime = runtime;
      this.store = store;
      this.indexer = indexer;
      this.notifier = notifier;
      this.unsubscribeRuntime = runtime.subscribe((runtimeStatus) => {
        this.setStatus({ ...this.status, runtime: runtimeStatus });
      });
      this.unsubscribeIndex = indexer.subscribe((indexing) => {
        const state = stateFromProgress(indexing, this.status.state);
        this.setStatus({ ...this.status, state, indexing });
      });
      notifier.register();
      if (indexer.getProgress().state !== "completed")
        this.setStatus({ ...this.status, state: "indexing" });
      this.startIndexTask(indexer.ensureInitialIndex());
      return this.getStatus();
    } catch (error) {
      const failure = safeError(error);
      this.setStatus({ state: "failed", availability, failure });
      this.onError(error instanceof Error ? error : new Error(failure));
      await this.cleanupFailedStart();
      return this.getStatus();
    }
  }

  private startIndexTask(operation: Promise<unknown>): void {
    if (this.indexTask) throw new Error("Paper semantic indexing is already running");
    const token = this.lifecycleToken;
    const task = operation
      .then(() => undefined)
      .catch((error) => {
        if (token !== this.lifecycleToken) return;
        const failure = safeError(error);
        this.setStatus({ ...this.status, state: "failed", failure });
        this.onError(error instanceof Error ? error : new Error(failure));
      })
      .finally(() => {
        if (this.indexTask === task) this.indexTask = undefined;
      });
    this.indexTask = task;
  }

  private async cleanupFailedStart(): Promise<void> {
    this.notifier?.unregister();
    this.notifier = undefined;
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = undefined;
    this.indexer = undefined;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = undefined;
    await this.runtime?.stop().catch(() => undefined);
    this.runtime = undefined;
    await this.store?.close().catch(() => undefined);
    this.store = undefined;
  }

  private setStatus(status: PaperSemanticSubsystemStatus): void {
    this.status = cloneStatus(status);
    for (const listener of this.listeners) listener(this.getStatus());
  }
}

export function createZoteroPaperSemanticSubsystem(
  profileDirectory: string,
  runtimeFactory: SemanticRuntimeFactory,
  sourceProvider: PaperSemanticSourceProvider = new ZoteroPaperSourceProvider(),
  indexRoot = PathUtils.join(profileDirectory, "zaichat", "semantic"),
): PaperSemanticSubsystem {
  const indexFiles = new SemanticIndexFileManager(
    new ZoteroSemanticArtifactFileSystem(),
    indexRoot,
    "zaichat@booknary.github.io",
  );
  return new PaperSemanticSubsystem({
    runtimeFactory,
    model: runtimeFactory.getModelFingerprint(),
    sourceProvider,
    openDatabase: async () => ZoteroSemanticDatabase.open(await indexFiles.prepare()),
    createNotifier: (indexer, provider) =>
      new ZoteroPaperIndexNotifier(indexer, provider),
    onError: (error) => Zotero.logError(sanitizedSubsystemError(error)),
  });
}

function stateFromProgress(
  progress: PaperIndexProgress,
  fallback: PaperSemanticSubsystemState,
): PaperSemanticSubsystemState {
  if (progress.state === "running" || progress.state === "cancelling")
    return "indexing";
  if (progress.state === "paused") return "paused";
  if (progress.state === "completed") return "ready";
  if (progress.state === "failed") return "failed";
  return fallback;
}

function cloneStatus(
  status: PaperSemanticSubsystemStatus,
): PaperSemanticSubsystemStatus {
  return {
    ...status,
    ...(status.runtime ? { runtime: { ...status.runtime } } : {}),
    ...(status.indexing ? { indexing: { ...status.indexing } } : {}),
  };
}

function sanitizedSubsystemError(error: Error): Error {
  return new Error(`Paper semantic subsystem failed (${error.name})`);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}
