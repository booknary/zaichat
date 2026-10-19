import { EmbeddingRuntimeManager } from "./embeddingRuntimeManager";
import {
  SemanticArtifactManager,
  SemanticArtifactManifest,
  SemanticArtifactStatus,
} from "./semanticArtifactManager";
import { EmbeddingProcessLauncher } from "./runtimeTypes";

export interface SemanticRuntimeFactoryOptions {
  protocolVersion: number;
  arguments?: string[];
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxCrashRestarts?: number;
  crashBackoffMs?: number[];
}

export interface SemanticRuntimeAvailability {
  available: boolean;
  runtime: SemanticArtifactStatus;
  model: SemanticArtifactStatus;
  failure?: string;
}

export class SemanticRuntimeFactory {
  constructor(
    private readonly launcher: EmbeddingProcessLauncher,
    private readonly runtimeArtifacts: SemanticArtifactManager,
    private readonly modelArtifacts: SemanticArtifactManager,
    private readonly runtimeManifest: SemanticArtifactManifest,
    private readonly modelManifest: SemanticArtifactManifest,
    private readonly options: SemanticRuntimeFactoryOptions,
  ) {}

  getModelFingerprint() {
    if (!this.modelManifest.model)
      throw new Error("Semantic model manifest has no model fingerprint");
    return { ...this.modelManifest.model };
  }

  async inspect(): Promise<SemanticRuntimeAvailability> {
    const [runtime, model] = await Promise.all([
      this.runtimeArtifacts.inspect(this.runtimeManifest),
      this.modelArtifacts.inspect(this.modelManifest),
    ]);
    const failure = !runtime.verified
      ? runtime.failure || "Embedding runtime is not installed"
      : !model.verified
        ? model.failure || "Embedding model is not installed"
        : undefined;
    return {
      available: runtime.verified && model.verified,
      runtime,
      model,
      ...(failure ? { failure } : {}),
    };
  }

  async create(): Promise<EmbeddingRuntimeManager> {
    const availability = await this.inspect();
    if (!availability.available)
      throw new Error(availability.failure || "Semantic runtime is unavailable");
    const executable = this.runtimeManifest.files.filter((file) => file.executable);
    if (executable.length !== 1)
      throw new Error("Semantic runtime manifest must declare one executable");
    const model = this.getModelFingerprint();
    return new EmbeddingRuntimeManager(this.launcher, {
      runtimeVersion: this.runtimeManifest.version,
      protocolVersion: this.options.protocolVersion,
      command: joinArtifactPath(
        availability.runtime.location,
        executable[0].relativePath,
      ),
      arguments: [...(this.options.arguments || [])],
      modelDirectory: availability.model.location,
      model,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 30_000,
      startupTimeoutMs: this.options.startupTimeoutMs ?? 30_000,
      shutdownTimeoutMs: this.options.shutdownTimeoutMs ?? 5_000,
      idleTimeoutMs: this.options.idleTimeoutMs ?? 10 * 60_000,
      maxCrashRestarts: this.options.maxCrashRestarts ?? 3,
      crashBackoffMs: [...(this.options.crashBackoffMs || [1_000, 5_000, 30_000])],
    });
  }
}

function joinArtifactPath(root: string, relativePath: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  const parts = relativePath.replace(/\\/g, "/").split("/");
  return [root.replace(/[\\/]$/, ""), ...parts].join(separator);
}
