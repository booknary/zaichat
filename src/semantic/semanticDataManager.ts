import {
  SemanticArtifactManager,
  SemanticArtifactManifest,
  SemanticArtifactSource,
  SemanticArtifactStatus,
} from "./semanticArtifactManager";
import {
  SemanticIndexFileManager,
  SemanticIndexFileStatus,
} from "./semanticIndexFileManager";
import { PaperSemanticSubsystemStatus } from "./paperSemanticSubsystem";
import { SemanticModelFingerprint } from "./types";
import { PaperSemanticSearchResult } from "./types";

interface PaperSemanticSubsystemLike {
  getStatus(): PaperSemanticSubsystemStatus;
  start(): Promise<PaperSemanticSubsystemStatus>;
  stop(): Promise<void>;
  waitForIndexing(): Promise<void>;
  rebuildIndex(): Promise<void>;
  pauseIndexing(): Promise<void>;
  resumeIndexing(): Promise<void>;
  cancelIndexing(): Promise<void>;
  searchPapers(query: string, limit?: number): Promise<PaperSemanticSearchResult[]>;
}

export interface SemanticDataStatus {
  runtime: SemanticArtifactStatus;
  model: SemanticArtifactStatus;
  index: SemanticIndexFileStatus & { vectorCount: number };
  subsystem: PaperSemanticSubsystemStatus;
  modelFingerprint: SemanticModelFingerprint;
  totalDiskUsage: number;
}

export interface SemanticDataManagerDependencies {
  runtimeArtifacts: SemanticArtifactManager;
  modelArtifacts: SemanticArtifactManager;
  runtimeManifest: SemanticArtifactManifest;
  modelManifest: SemanticArtifactManifest;
  artifactSource: SemanticArtifactSource;
  indexFiles: SemanticIndexFileManager;
  subsystem: PaperSemanticSubsystemLike;
  inspectVectorCount?: () => Promise<number>;
  probeRuntime?: () => Promise<void>;
  additionalIndexFiles?: SemanticIndexFileManager[];
}

export class SemanticDataManager {
  private operation?: Promise<unknown>;

  constructor(private readonly dependencies: SemanticDataManagerDependencies) {
    if (!dependencies.modelManifest.model)
      throw new Error("Semantic model manifest has no model fingerprint");
  }

  async inspect(): Promise<SemanticDataStatus> {
    const [runtime, model, index] = await Promise.all([
      this.dependencies.runtimeArtifacts.inspect(this.dependencies.runtimeManifest),
      this.dependencies.modelArtifacts.inspect(this.dependencies.modelManifest),
      this.dependencies.indexFiles.inspect(),
    ]);
    const subsystem = this.dependencies.subsystem.getStatus();
    let vectorCount = subsystem.indexing?.vectorCount;
    if (vectorCount === undefined && index.installed && index.verified)
      vectorCount = await this.dependencies.inspectVectorCount?.();
    return {
      runtime,
      model,
      index: { ...index, vectorCount: vectorCount || 0 },
      subsystem,
      modelFingerprint: { ...this.dependencies.modelManifest.model! },
      totalDiskUsage: runtime.diskUsage + model.diskUsage + index.diskUsage,
    };
  }

  async start(): Promise<SemanticDataStatus> {
    await this.dependencies.subsystem.start();
    return this.inspect();
  }

  async stop(): Promise<void> {
    await this.dependencies.subsystem.stop();
  }

  async searchPapers(query: string, limit = 30): Promise<PaperSemanticSearchResult[]> {
    const status = this.dependencies.subsystem.getStatus();
    if (status.state === "stopped" || status.state === "unavailable")
      await this.dependencies.subsystem.start();
    if (this.dependencies.subsystem.getStatus().state !== "ready") return [];
    return this.dependencies.subsystem.searchPapers(query, limit);
  }

  async pauseIndexing(): Promise<SemanticDataStatus> {
    await this.dependencies.subsystem.pauseIndexing();
    return this.inspect();
  }

  async resumeIndexing(): Promise<SemanticDataStatus> {
    await this.dependencies.subsystem.resumeIndexing();
    return this.inspect();
  }

  async cancelIndexing(): Promise<SemanticDataStatus> {
    await this.dependencies.subsystem.cancelIndexing();
    return this.inspect();
  }

  installRequired(
    confirmed: boolean,
    options: {
      signal?: AbortSignal;
      startAfterInstall?: boolean;
      onProgress?: (received: number, total: number, file: string) => void;
    } = {},
  ): Promise<SemanticDataStatus> {
    return this.runExclusive(async () => {
      if (!confirmed)
        throw new Error(
          "Semantic runtime and model installation requires confirmation",
        );
      await this.dependencies.runtimeArtifacts.install(
        this.dependencies.runtimeManifest,
        this.dependencies.artifactSource,
        { confirmed: true, signal: options.signal, onProgress: options.onProgress },
      );
      await this.dependencies.modelArtifacts.install(
        this.dependencies.modelManifest,
        this.dependencies.artifactSource,
        { confirmed: true, signal: options.signal, onProgress: options.onProgress },
      );
      if (options.startAfterInstall !== false)
        await this.dependencies.subsystem.start();
      return this.inspect();
    });
  }

  clearIndex(confirmed: boolean): Promise<SemanticDataStatus> {
    return this.runExclusive(async () => {
      if (!confirmed)
        throw new Error("Clearing the semantic index requires confirmation");
      await this.dependencies.subsystem.stop();
      await this.dependencies.indexFiles.clear(true);
      return this.inspect();
    });
  }

  async probeRuntime(): Promise<void> {
    if (!this.dependencies.probeRuntime)
      throw new Error("Runtime deployment self-test is unavailable");
    await this.dependencies.probeRuntime();
  }

  rebuildIndex(): Promise<SemanticDataStatus> {
    return this.runExclusive(async () => {
      const started = await this.dependencies.subsystem.start();
      if (started.state === "unavailable")
        throw new Error(started.failure || "Semantic subsystem is unavailable");
      await this.dependencies.subsystem.waitForIndexing();
      await this.dependencies.subsystem.rebuildIndex();
      await this.dependencies.subsystem.waitForIndexing();
      return this.inspect();
    });
  }

  deleteModel(confirmed: boolean): Promise<SemanticDataStatus> {
    return this.runExclusive(async () => {
      if (!confirmed)
        throw new Error("Deleting the semantic model requires confirmation");
      await this.dependencies.subsystem.stop();
      await this.dependencies.modelArtifacts.delete(
        this.dependencies.modelManifest,
        true,
      );
      return this.inspect();
    });
  }

  deleteAllSemanticData(confirmed: boolean): Promise<SemanticDataStatus> {
    return this.runExclusive(async () => {
      if (!confirmed)
        throw new Error("Deleting all semantic data requires confirmation");
      await this.dependencies.subsystem.stop();
      await this.dependencies.indexFiles.deleteAll(true);
      for (const files of this.dependencies.additionalIndexFiles || [])
        await files.deleteAll(true);
      await this.dependencies.modelArtifacts.deleteAllManagedData(true);
      await this.dependencies.runtimeArtifacts.deleteAllManagedData(true);
      return this.inspect();
    });
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operation)
      return Promise.reject(new Error("Another semantic data operation is running"));
    const current = operation().finally(() => {
      if (this.operation === current) this.operation = undefined;
    });
    this.operation = current;
    return current;
  }
}
