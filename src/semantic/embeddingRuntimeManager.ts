import { NDJSONWorkerClient } from "./ndjsonWorkerClient";
import {
  EmbeddingProcessLauncher,
  EmbeddingRuntimeConfiguration,
  EmbeddingRuntimeState,
  EmbeddingRuntimeStatus,
  WorkerResponse,
} from "./runtimeTypes";
import { SemanticEmbeddingProvider } from "./types";

type RuntimeListener = (status: EmbeddingRuntimeStatus) => void;

interface HelloResponse extends WorkerResponse {
  protocolVersion: number;
  runtimeVersion: string;
  pid?: number;
}

interface EmbedResponse extends WorkerResponse {
  vectors: number[][];
}

export class EmbeddingRuntimeManager {
  private state: EmbeddingRuntimeState = "stopped";
  private crashCount = 0;
  private pid?: number;
  private lastError?: string;
  private client?: NDJSONWorkerClient;
  private startPromise?: Promise<NDJSONWorkerClient>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private launchToken = 0;
  private activeRequests = 0;
  private autoRestart = false;
  private restartCircuitOpen = false;
  private readonly listeners = new Set<RuntimeListener>();

  constructor(
    private readonly launcher: EmbeddingProcessLauncher,
    private readonly configuration: EmbeddingRuntimeConfiguration,
  ) {
    validateConfiguration(configuration);
  }

  getStatus(): EmbeddingRuntimeStatus {
    return {
      state: this.state,
      crashCount: this.crashCount,
      ...(this.pid === undefined ? {} : { pid: this.pid }),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  async ensureReady(): Promise<void> {
    await this.getReadyClient();
  }

  async retryNow(): Promise<void> {
    if (this.client && this.state === "ready") return;
    this.crashCount = 0;
    this.restartCircuitOpen = false;
    this.lastError = undefined;
    this.updateState("stopped");
    await this.getReadyClient();
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    if (texts.some((text) => !text.trim()))
      throw new Error("Embedding documents must not contain empty text");
    return this.embed("embed_documents", texts);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    if (!text.trim()) throw new Error("Embedding query must not be empty");
    return (await this.embed("embed_query", [text]))[0];
  }

  async stop(): Promise<void> {
    this.autoRestart = false;
    this.clearIdleTimer();
    const pendingStart = this.startPromise;
    ++this.launchToken;
    const client = this.client;
    this.client = undefined;
    this.startPromise = undefined;
    if (!client) {
      await pendingStart?.catch(() => undefined);
      this.updateState("stopped");
      return;
    }
    this.updateState("stopping");
    try {
      await client.request(
        { command: "shutdown" },
        this.configuration.shutdownTimeoutMs,
      );
      await withTimeout(
        client.wait(),
        this.configuration.shutdownTimeoutMs,
        "Embedding worker shutdown timed out",
      );
    } catch {
      await client.kill(this.configuration.shutdownTimeoutMs).catch(() => undefined);
    } finally {
      this.pid = undefined;
      this.updateState("stopped");
    }
  }

  private async embed(
    command: "embed_documents" | "embed_query",
    texts: string[],
  ): Promise<Float32Array[]> {
    this.activeRequests += 1;
    this.clearIdleTimer();
    try {
      const client = await this.getReadyClient();
      const response = await client.request<EmbedResponse>({ command, texts });
      if (!Array.isArray(response.vectors) || response.vectors.length !== texts.length)
        throw new Error("Embedding worker returned an invalid vector batch");
      return response.vectors.map((value) =>
        validateVector(value, this.configuration.model.dimensions),
      );
    } finally {
      this.activeRequests -= 1;
      this.scheduleIdleStop();
    }
  }

  private async getReadyClient(): Promise<NDJSONWorkerClient> {
    this.clearIdleTimer();
    if (this.client && this.state === "ready") return this.client;
    if (this.startPromise) return this.startPromise;
    if (this.state === "incompatible")
      throw new Error(this.lastError || "Embedding worker is incompatible");
    if (this.state === "crashed" && this.restartCircuitOpen)
      throw new Error("Embedding worker automatic restart limit was reached");
    this.autoRestart = true;
    const token = ++this.launchToken;
    this.startPromise = this.start(token).finally(() => {
      if (token === this.launchToken) this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async start(token: number): Promise<NDJSONWorkerClient> {
    this.updateState("starting");
    let launchedClient: NDJSONWorkerClient | undefined;
    try {
      const process = await this.launcher.launch({
        command: this.configuration.command,
        arguments: [...this.configuration.arguments],
      });
      const client = new NDJSONWorkerClient(
        process,
        this.configuration.requestTimeoutMs,
      );
      launchedClient = client;
      const hello = await client.request<HelloResponse>(
        { command: "hello" },
        this.configuration.startupTimeoutMs,
      );
      this.validateHello(hello);
      await client.request(
        {
          command: "load_model",
          modelDirectory: this.configuration.modelDirectory,
          model: {
            id: this.configuration.model.modelID,
            version: this.configuration.model.version,
            dimensions: this.configuration.model.dimensions,
            fingerprint: this.configuration.model.fingerprint,
          },
        },
        this.configuration.startupTimeoutMs,
      );
      if (token !== this.launchToken) {
        await client.kill(this.configuration.shutdownTimeoutMs);
        throw new Error("Embedding worker startup was superseded");
      }
      this.client = client;
      this.restartCircuitOpen = false;
      this.pid = hello.pid;
      this.lastError = undefined;
      this.updateState("ready");
      void client.wait().then(
        (exit) => this.onProcessExit(token, exit.exitCode),
        (error) => this.onProcessExit(token, undefined, error),
      );
      this.scheduleIdleStop();
      return client;
    } catch (error) {
      await launchedClient
        ?.kill(this.configuration.shutdownTimeoutMs)
        .catch(() => undefined);
      if (token === this.launchToken) {
        this.lastError = safeError(error);
        this.updateState(
          /protocol|runtime version|model/i.test(this.lastError)
            ? "incompatible"
            : "crashed",
        );
      }
      throw error;
    }
  }

  private validateHello(hello: HelloResponse): void {
    if (hello.protocolVersion !== this.configuration.protocolVersion)
      throw new Error(
        `Embedding worker protocol mismatch: expected ${this.configuration.protocolVersion}`,
      );
    if (hello.runtimeVersion !== this.configuration.runtimeVersion)
      throw new Error(
        `Embedding worker runtime version mismatch: expected ${this.configuration.runtimeVersion}`,
      );
  }

  private onProcessExit(token: number, exitCode?: number, error?: unknown): void {
    if (token !== this.launchToken || this.state === "stopping") return;
    this.client = undefined;
    this.pid = undefined;
    this.crashCount += 1;
    this.lastError = safeError(
      error ||
        new Error(`Embedding worker exited unexpectedly (${exitCode ?? "unknown"})`),
    );
    this.updateState("crashed");
    if (!this.autoRestart) return;
    if (this.crashCount > this.configuration.maxCrashRestarts) {
      this.restartCircuitOpen = true;
      return;
    }
    const recovery = this.recoverFromCrash();
    const tracked = recovery.finally(() => {
      if (this.startPromise === tracked) this.startPromise = undefined;
    });
    this.startPromise = tracked;
    void this.startPromise.catch(() => undefined);
  }

  private async recoverFromCrash(): Promise<NDJSONWorkerClient> {
    let lastError: unknown = new Error("Embedding worker recovery failed");
    while (this.autoRestart && this.crashCount <= this.configuration.maxCrashRestarts) {
      const delayMs =
        this.configuration.crashBackoffMs[
          Math.min(this.crashCount - 1, this.configuration.crashBackoffMs.length - 1)
        ];
      this.updateState("backoff");
      await delay(delayMs);
      if (!this.autoRestart) throw new Error("Embedding worker recovery was stopped");
      const token = ++this.launchToken;
      try {
        return await this.start(token);
      } catch (error) {
        lastError = error;
        if (this.state === "incompatible") {
          this.restartCircuitOpen = true;
          throw error;
        }
        this.crashCount += 1;
      }
    }
    this.restartCircuitOpen = true;
    this.updateState("crashed");
    throw lastError;
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    if (
      this.configuration.idleTimeoutMs <= 0 ||
      this.activeRequests > 0 ||
      this.state !== "ready"
    )
      return;
    this.idleTimer = setTimeout(
      () => void this.stop(),
      this.configuration.idleTimeoutMs,
    );
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private updateState(state: EmbeddingRuntimeState): void {
    this.state = state;
    const snapshot = this.getStatus();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export class SidecarSemanticEmbeddingProvider implements SemanticEmbeddingProvider {
  constructor(private readonly runtime: EmbeddingRuntimeManager) {}

  embedDocuments(texts: string[]): Promise<Float32Array[]> {
    return this.runtime.embedDocuments(texts);
  }

  embedQuery(text: string): Promise<Float32Array> {
    return this.runtime.embedQuery(text);
  }
}

function validateConfiguration(configuration: EmbeddingRuntimeConfiguration): void {
  if (!configuration.command.trim())
    throw new Error("Embedding runtime command is required");
  if (
    !Number.isInteger(configuration.protocolVersion) ||
    configuration.protocolVersion <= 0
  )
    throw new Error("Embedding runtime protocol version must be positive");
  for (const [name, value] of Object.entries({
    requestTimeoutMs: configuration.requestTimeoutMs,
    startupTimeoutMs: configuration.startupTimeoutMs,
    shutdownTimeoutMs: configuration.shutdownTimeoutMs,
    idleTimeoutMs: configuration.idleTimeoutMs,
  })) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Embedding runtime ${name} is invalid`);
  }
  if (!configuration.crashBackoffMs.length)
    throw new Error("Embedding runtime crash backoff is required");
  if (
    !Number.isInteger(configuration.maxCrashRestarts) ||
    configuration.maxCrashRestarts < 0
  )
    throw new Error("Embedding runtime restart limit is invalid");
}

function validateVector(value: unknown, dimensions: number): Float32Array {
  if (!Array.isArray(value) || value.length !== dimensions)
    throw new Error(`Embedding worker vector must have ${dimensions} dimensions`);
  if (value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry)))
    throw new Error("Embedding worker returned a non-finite vector");
  const vector = new Float32Array(value);
  return vector;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}
