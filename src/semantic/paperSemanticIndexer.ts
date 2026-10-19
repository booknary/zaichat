import { SemanticIndexCoordinator } from "./semanticIndexCoordinator";
import { SemanticIndexStore } from "./semanticIndexStore";
import {
  PAPER_NAMESPACE,
  PaperIndexProgress,
  PaperSemanticRef,
  PaperSemanticSourceProvider,
  SemanticGeneration,
  SemanticIndexJob,
  SemanticModelFingerprint,
} from "./types";

export interface PaperSemanticIndexerOptions {
  batchSize?: number;
  yieldControl?: () => Promise<void>;
}

export class PaperSemanticIndexer {
  private readonly listeners = new Set<(progress: PaperIndexProgress) => void>();
  private readonly batchSize: number;
  private readonly yieldControl: () => Promise<void>;
  private progress: PaperIndexProgress = emptyProgress();
  private runPromise?: Promise<SemanticGeneration | null>;
  private currentJob?: SemanticIndexJob;
  private pauseRequested = false;
  private cancelRequested = false;
  private shutdownRequested = false;
  private pauseAcknowledged?: () => void;
  private resumeRun?: () => void;
  private readonly deferredRefs = new Map<string, PaperSemanticRef>();
  private deferredDeleteReconciliation = false;
  private incrementalTask: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: SemanticIndexStore,
    private readonly coordinator: SemanticIndexCoordinator,
    private readonly sourceProvider: PaperSemanticSourceProvider,
    private readonly model: SemanticModelFingerprint,
    options: PaperSemanticIndexerOptions = {},
  ) {
    this.batchSize = Math.min(100, Math.max(1, options.batchSize || 16));
    this.yieldControl = options.yieldControl || defaultYield;
  }

  async initialize(): Promise<PaperIndexProgress> {
    await this.store.initialize();
    const recoverable = await this.store.getRecoverableIndexJob(
      PAPER_NAMESPACE,
      this.model.fingerprint,
    );
    if (recoverable) {
      const generation = await this.store.getGeneration(recoverable.generationID);
      if (generation?.state === "building") {
        this.currentJob = await this.store.setIndexJobState(
          recoverable.jobID,
          "paused",
          recoverable.state === "running" ? "interrupted" : undefined,
        );
        this.setProgress({
          state: "paused",
          jobID: this.currentJob.jobID,
          generationID: this.currentJob.generationID,
          totalItems: this.currentJob.totalItems,
          completedItems: this.currentJob.completedItems,
          vectorCount: generation.recordCount,
          recovered: true,
        });
        return this.getProgress();
      }
      await this.store.setIndexJobState(
        recoverable.jobID,
        "failed",
        "generation-unavailable",
      );
    }
    const active = await this.store.getActiveGeneration(PAPER_NAMESPACE);
    this.setProgress({
      state:
        active?.model.fingerprint === this.model.fingerprint ? "completed" : "idle",
      generationID: active?.generationID,
      totalItems: 0,
      completedItems: 0,
      vectorCount: active?.recordCount || 0,
      recovered: false,
    });
    return this.getProgress();
  }

  getProgress(): PaperIndexProgress {
    return { ...this.progress };
  }

  subscribe(listener: (progress: PaperIndexProgress) => void): () => void {
    this.listeners.add(listener);
    listener(this.getProgress());
    return () => this.listeners.delete(listener);
  }

  async ensureInitialIndex(): Promise<SemanticGeneration> {
    const active = await this.store.getActiveGeneration(PAPER_NAMESPACE);
    if (active?.model.fingerprint === this.model.fingerprint) {
      // Notifications cannot cover edits made while the plugin was stopped.
      // Reconcile metadata hashes on startup without rebuilding the generation.
      for (const ref of await this.sourceProvider.listPaperRefs()) {
        if (this.shutdownRequested) return active;
        await this.synchronizePaper(ref);
        await this.yieldControl();
      }
      if (!this.shutdownRequested) await this.requestDeleteReconciliation();
      return active;
    }
    if (this.currentJob) {
      const resumed = await this.resume();
      if (resumed) return resumed;
    }
    const rebuilt = await this.rebuild();
    if (!rebuilt) throw new Error("Paper semantic indexing was cancelled");
    return rebuilt;
  }

  async rebuild(): Promise<SemanticGeneration | null> {
    if (this.runPromise) return this.runPromise;
    const refs = await this.sourceProvider.listPaperRefs();
    const generation = await this.store.createGeneration(PAPER_NAMESPACE, this.model);
    this.currentJob = await this.store.createIndexJob(
      PAPER_NAMESPACE,
      generation.generationID,
      this.model.fingerprint,
      refs,
    );
    await this.sourceProvider.prepareForIndexing?.();
    return this.startRun(this.currentJob, false);
  }

  async pause(): Promise<void> {
    if (!this.runPromise || this.progress.state !== "running") return;
    this.pauseRequested = true;
    await new Promise<void>((resolve) => {
      this.pauseAcknowledged = resolve;
    });
  }

  async resume(): Promise<SemanticGeneration | null> {
    if (this.runPromise) {
      if (this.progress.state === "paused") {
        this.pauseRequested = false;
        this.resumeRun?.();
      }
      return this.runPromise;
    }
    if (!this.currentJob) {
      const recovered = await this.store.getRecoverableIndexJob(
        PAPER_NAMESPACE,
        this.model.fingerprint,
      );
      if (!recovered) return null;
      this.currentJob = recovered;
    }
    await this.sourceProvider.prepareForIndexing?.();
    return this.startRun(this.currentJob, true);
  }

  async cancel(): Promise<void> {
    if (!this.currentJob) return;
    this.cancelRequested = true;
    this.setProgress({ ...this.progress, state: "cancelling" });
    if (this.runPromise) {
      this.pauseRequested = false;
      this.resumeRun?.();
      await this.runPromise;
      return;
    }
    await this.cancelJob(this.currentJob);
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.pauseRequested = false;
    this.resumeRun?.();
    await this.runPromise?.catch(() => undefined);
    await this.incrementalTask;
  }

  async synchronizePaper(ref: PaperSemanticRef): Promise<void> {
    if (this.runPromise) {
      this.deferredRefs.set(refKey(ref), ref);
      return;
    }
    const task = this.incrementalTask.then(async () => {
      if (!this.shutdownRequested) await this.applyPaperRef(ref);
    });
    // The caller receives failures; the queue must remain usable for later events.
    this.incrementalTask = task.then(
      () => undefined,
      () => undefined,
    );
    await task;
  }

  async requestDeleteReconciliation(): Promise<void> {
    if (this.runPromise) {
      this.deferredDeleteReconciliation = true;
      return;
    }
    await this.reconcileDeletedPapers();
  }

  private async applyPaperRef(ref: PaperSemanticRef): Promise<void> {
    const active = await this.store.getActiveGeneration(PAPER_NAMESPACE);
    if (!active || active.model.fingerprint !== this.model.fingerprint) return;
    const source = await this.sourceProvider.getPaper(ref.libraryID, ref.itemKey);
    if (source) await this.coordinator.indexPaper(source);
    else await this.coordinator.deletePaper(ref.libraryID, ref.itemKey);
  }

  async reconcileDeletedPapers(): Promise<number> {
    const active = await this.store.getActiveGeneration(PAPER_NAMESPACE);
    if (!active || active.model.fingerprint !== this.model.fingerprint) return 0;
    let deleted = 0;
    for (const ref of await this.store.listIndexedSources(active.generationID)) {
      if (await this.sourceProvider.getPaper(ref.libraryID, ref.itemKey)) continue;
      deleted += await this.coordinator.deletePaper(ref.libraryID, ref.itemKey);
      await this.yieldControl();
    }
    return deleted;
  }

  private startRun(
    job: SemanticIndexJob,
    recovered: boolean,
  ): Promise<SemanticGeneration | null> {
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.shutdownRequested = false;
    this.runPromise = this.run(job, recovered).finally(() => {
      this.pauseAcknowledged?.();
      this.runPromise = undefined;
      this.resumeRun = undefined;
      this.pauseAcknowledged = undefined;
    });
    return this.runPromise;
  }

  private async run(
    initialJob: SemanticIndexJob,
    recovered: boolean,
  ): Promise<SemanticGeneration | null> {
    let job = await this.store.setIndexJobState(initialJob.jobID, "running");
    this.currentJob = job;
    this.setProgress(await this.progressFromJob(job, "running", recovered));
    try {
      while (true) {
        await this.checkpoint(job, recovered);
        const pending = await this.store.listPendingIndexJobItems(
          job.jobID,
          this.batchSize,
        );
        if (!pending.length) break;
        for (const ref of pending) {
          await this.checkpoint(job, recovered);
          const source = await this.sourceProvider.getPaper(ref.libraryID, ref.itemKey);
          const vectorCount = source
            ? await this.coordinator.replacePaperInGeneration(job.generationID, source)
            : 0;
          if (!source)
            await this.coordinator.deletePaperFromGeneration(
              job.generationID,
              ref.libraryID,
              ref.itemKey,
            );
          job = await this.store.markIndexJobItemsCompleted(job.jobID, [ref.position]);
          this.currentJob = job;
          const generation = await this.store.getGeneration(job.generationID);
          this.setProgress({
            state: "running",
            jobID: job.jobID,
            generationID: job.generationID,
            totalItems: job.totalItems,
            completedItems: job.completedItems,
            vectorCount: generation?.recordCount || vectorCount,
            recovered,
          });
          await this.yieldControl();
        }
      }
      await this.checkpoint(job, recovered);
      const generation = await this.store.activateGeneration(job.generationID);
      job = await this.store.setIndexJobState(job.jobID, "completed");
      this.currentJob = undefined;
      this.setProgress({
        state: "completed",
        jobID: job.jobID,
        generationID: generation.generationID,
        totalItems: job.totalItems,
        completedItems: job.completedItems,
        vectorCount: generation.recordCount,
        recovered,
      });
      await this.flushDeferredUpdates();
      return generation;
    } catch (error) {
      if (error instanceof IndexCancelledError) {
        await this.cancelJob(job);
        return null;
      }
      if (error instanceof IndexShutdownError) {
        const paused = await this.store.setIndexJobState(job.jobID, "paused");
        this.currentJob = paused;
        this.setProgress(await this.progressFromJob(paused, "paused", recovered));
        return null;
      }
      await this.store.markGenerationFailed(job.generationID);
      job = await this.store.setIndexJobState(job.jobID, "failed", "indexing-error");
      this.currentJob = undefined;
      this.setProgress({
        ...(await this.progressFromJob(job, "failed", recovered)),
        state: "failed",
      });
      throw error;
    }
  }

  private async checkpoint(job: SemanticIndexJob, recovered: boolean): Promise<void> {
    if (this.cancelRequested) throw new IndexCancelledError();
    if (this.shutdownRequested) throw new IndexShutdownError();
    if (!this.pauseRequested) return;
    const paused = await this.store.setIndexJobState(job.jobID, "paused");
    this.currentJob = paused;
    this.setProgress(await this.progressFromJob(paused, "paused", recovered));
    this.pauseAcknowledged?.();
    this.pauseAcknowledged = undefined;
    await new Promise<void>((resolve) => {
      this.resumeRun = resolve;
    });
    this.resumeRun = undefined;
    if (this.cancelRequested) throw new IndexCancelledError();
    if (this.shutdownRequested) throw new IndexShutdownError();
    const running = await this.store.setIndexJobState(job.jobID, "running");
    this.currentJob = running;
    this.setProgress(await this.progressFromJob(running, "running", recovered));
  }

  private async cancelJob(job: SemanticIndexJob): Promise<void> {
    await this.store.markGenerationFailed(job.generationID);
    const cancelled = await this.store.setIndexJobState(job.jobID, "cancelled");
    this.currentJob = undefined;
    this.setProgress({
      ...(await this.progressFromJob(cancelled, "cancelled", this.progress.recovered)),
      state: "cancelled",
    });
  }

  private async progressFromJob(
    job: SemanticIndexJob,
    state: PaperIndexProgress["state"],
    recovered: boolean,
  ): Promise<PaperIndexProgress> {
    const generation = await this.store.getGeneration(job.generationID);
    return {
      state,
      jobID: job.jobID,
      generationID: job.generationID,
      totalItems: job.totalItems,
      completedItems: job.completedItems,
      vectorCount: generation?.recordCount || 0,
      recovered,
    };
  }

  private setProgress(progress: PaperIndexProgress): void {
    this.progress = progress;
    for (const listener of this.listeners) listener(this.getProgress());
  }

  private async flushDeferredUpdates(): Promise<void> {
    const refs = [...this.deferredRefs.values()];
    this.deferredRefs.clear();
    for (const ref of refs) await this.applyPaperRef(ref);
    if (this.deferredDeleteReconciliation) {
      this.deferredDeleteReconciliation = false;
      await this.reconcileDeletedPapers();
    }
  }
}

class IndexCancelledError extends Error {}
class IndexShutdownError extends Error {}

function emptyProgress(): PaperIndexProgress {
  return {
    state: "idle",
    totalItems: 0,
    completedItems: 0,
    vectorCount: 0,
    recovered: false,
  };
}

async function defaultYield(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function refKey(ref: PaperSemanticRef): string {
  return `${ref.libraryID}:${ref.itemKey}`;
}
