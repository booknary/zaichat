import { describe, expect, it } from "vitest";
import { EmbeddingRuntimeManager } from "../src/semantic/embeddingRuntimeManager";
import {
  EmbeddingProcess,
  EmbeddingProcessLaunch,
  EmbeddingProcessLauncher,
  EmbeddingRuntimeConfiguration,
} from "../src/semantic/runtimeTypes";

describe("EmbeddingRuntimeManager", () => {
  it("coalesces startup, validates the handshake, and embeds through NDJSON", async () => {
    const launcher = new FakeLauncher();
    const manager = new EmbeddingRuntimeManager(launcher, configuration());

    await Promise.all([manager.ensureReady(), manager.ensureReady()]);
    const [documents, query] = await Promise.all([
      manager.embedDocuments(["passage: alpha", "passage: beta"]),
      manager.embedQuery("query: alpha"),
    ]);

    expect(launcher.processes).toHaveLength(1);
    expect(manager.getStatus().state).toBe("ready");
    expect([...documents[0]]).toEqual([1, 0, 0]);
    expect([...documents[1]]).toEqual([0, 1, 0]);
    expect([...query]).toEqual([1, 0, 0]);

    await manager.stop();
    expect(manager.getStatus().state).toBe("stopped");
    expect(launcher.processes[0].exitCode).toBe(0);
  });

  it("writes multilingual NDJSON as ASCII escapes for the Windows worker pipe", async () => {
    const launcher = new FakeLauncher();
    const manager = new EmbeddingRuntimeManager(launcher, configuration());
    const query = "query: 两次基因组创新 🧬";

    await manager.embedQuery(query);

    const request = launcher.processes[0].writes.find((line) =>
      line.includes('"command":"embed_query"'),
    );
    expect(request).toBeDefined();
    expect(request).not.toContain("两次基因组创新");
    expect(request).not.toContain("🧬");
    expect(request).toContain("\\u4e24");
    expect((JSON.parse(request!) as { texts: string[] }).texts).toEqual([query]);
    await manager.stop();
  });

  it("recovers automatically after an unexpected process exit", async () => {
    const launcher = new FakeLauncher();
    const manager = new EmbeddingRuntimeManager(launcher, configuration());
    await manager.ensureReady();

    launcher.processes[0].exit(17);
    await eventually(() => launcher.processes.length === 2);
    await eventually(() => manager.getStatus().state === "ready");

    expect(manager.getStatus().crashCount).toBe(1);
    expect([...(await manager.embedQuery("query: recovered"))]).toEqual([1, 0, 0]);
    await manager.stop();
  });

  it("continues recovery when replacement startup also fails", async () => {
    const launcher = new FakeLauncher({}, new Set([1, 2]));
    const manager = new EmbeddingRuntimeManager(launcher, configuration());
    await manager.ensureReady();

    launcher.processes[0].exit(17);
    await eventually(() => launcher.processes.length === 4);
    await eventually(() => manager.getStatus().state === "ready");

    expect(manager.getStatus().crashCount).toBe(3);
    expect([...(await manager.embedQuery("query: recovered twice"))]).toEqual([
      1, 0, 0,
    ]);
    await manager.stop();
  });

  it("rejects an incompatible worker protocol without sending model data", async () => {
    const launcher = new FakeLauncher({ protocolVersion: 99 });
    const manager = new EmbeddingRuntimeManager(launcher, configuration());

    await expect(manager.ensureReady()).rejects.toThrow("protocol mismatch");
    expect(manager.getStatus().state).toBe("incompatible");
    expect(launcher.processes[0].commands).toEqual(["hello"]);
    launcher.processes[0].exit(1);
  });

  it("rejects malformed and non-finite embedding vectors", async () => {
    const launcher = new FakeLauncher({ invalidVectors: true });
    const manager = new EmbeddingRuntimeManager(launcher, configuration());

    await expect(manager.embedQuery("query: invalid")).rejects.toThrow(
      "non-finite vector",
    );
    await manager.stop();
  });

  it("opens the crash circuit until an explicit retry", async () => {
    const launcher = new FakeLauncher();
    const settings = configuration();
    settings.maxCrashRestarts = 0;
    const manager = new EmbeddingRuntimeManager(launcher, settings);
    await manager.ensureReady();

    launcher.processes[0].exit(17);
    await eventually(() => manager.getStatus().state === "crashed");
    await expect(manager.embedQuery("query: blocked")).rejects.toThrow("restart limit");
    expect(launcher.processes).toHaveLength(1);

    await manager.retryNow();
    expect(launcher.processes).toHaveLength(2);
    await manager.stop();
  });

  it("stops an idle ready worker automatically", async () => {
    const launcher = new FakeLauncher();
    const settings = configuration();
    settings.idleTimeoutMs = 5;
    const manager = new EmbeddingRuntimeManager(launcher, settings);
    await manager.ensureReady();

    await eventually(() => manager.getStatus().state === "stopped");
    expect(launcher.processes[0].exitCode).toBe(0);
  });
});

class FakeLauncher implements EmbeddingProcessLauncher {
  readonly processes: FakeProcess[] = [];

  constructor(
    private readonly behavior: {
      protocolVersion?: number;
      invalidVectors?: boolean;
    } = {},
    private readonly failedStartupIndexes = new Set<number>(),
  ) {}

  async launch(_options: EmbeddingProcessLaunch): Promise<EmbeddingProcess> {
    const process = new FakeProcess({
      ...this.behavior,
      failStartup: this.failedStartupIndexes.has(this.processes.length),
    });
    this.processes.push(process);
    return process;
  }
}

class FakeProcess implements EmbeddingProcess {
  readonly commands: string[] = [];
  readonly writes: string[] = [];
  exitCode?: number;
  private readonly stdoutPipe = new AsyncPipe();
  private readonly stderrPipe = new AsyncPipe();
  private readonly exitPromise: Promise<{ exitCode: number }>;
  private resolveExit!: (value: { exitCode: number }) => void;

  readonly stdin = {
    write: async (value: string) => {
      this.writes.push(value);
      for (const line of value.trim().split("\n")) this.handle(JSON.parse(line));
    },
    close: async () => undefined,
  };
  readonly stdout = { readString: () => this.stdoutPipe.read() };
  readonly stderr = { readString: () => this.stderrPipe.read() };

  constructor(
    private readonly behavior: {
      protocolVersion?: number;
      invalidVectors?: boolean;
      failStartup?: boolean;
    },
  ) {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  wait(): Promise<{ exitCode: number }> {
    return this.exitPromise;
  }

  async kill(): Promise<{ exitCode: number }> {
    this.exit(-9);
    return { exitCode: this.exitCode ?? -9 };
  }

  exit(code: number): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    this.stdoutPipe.close();
    this.stderrPipe.close();
    this.resolveExit({ exitCode: code });
  }

  private handle(message: Record<string, any>): void {
    const command = String(message.command);
    this.commands.push(command);
    if (command === "hello") {
      this.respond({
        id: message.id,
        ok: true,
        protocolVersion: this.behavior.protocolVersion ?? 1,
        runtimeVersion: "runtime-1",
        pid: 1234,
      });
      return;
    }
    if (command === "load_model") {
      this.respond(
        this.behavior.failStartup
          ? {
              id: message.id,
              ok: false,
              error: { code: "startup-failed", message: "fixture" },
            }
          : { id: message.id, ok: true },
      );
      return;
    }
    if (command === "embed_query" || command === "embed_documents") {
      const texts = message.texts as string[];
      const vectors = texts.map((_text, index) =>
        this.behavior.invalidVectors
          ? [Number.NaN, 0, 0]
          : index % 2
            ? [0, 1, 0]
            : [1, 0, 0],
      );
      this.respond({ id: message.id, ok: true, vectors });
      return;
    }
    if (command === "shutdown") {
      this.respond({ id: message.id, ok: true });
      queueMicrotask(() => this.exit(0));
      return;
    }
    this.respond({
      id: message.id,
      ok: false,
      error: { code: "unknown-command", message: command },
    });
  }

  private respond(value: Record<string, unknown>): void {
    const line = `${JSON.stringify(value)}\n`;
    const split = Math.max(1, Math.floor(line.length / 2));
    this.stdoutPipe.push(line.slice(0, split));
    this.stdoutPipe.push(line.slice(split));
  }
}

class AsyncPipe {
  private readonly values: string[] = [];
  private readonly readers: Array<(value: string) => void> = [];
  private closed = false;

  read(): Promise<string> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closed) return Promise.resolve("");
    return new Promise((resolve) => this.readers.push(resolve));
  }

  push(value: string): void {
    const reader = this.readers.shift();
    if (reader) reader(value);
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader("");
  }
}

function configuration(): EmbeddingRuntimeConfiguration {
  return {
    runtimeVersion: "runtime-1",
    protocolVersion: 1,
    command: "C:\\semantic\\worker.exe",
    arguments: ["--stdio"],
    modelDirectory: "C:\\semantic\\model",
    model: {
      modelID: "intfloat/multilingual-e5-small",
      version: "revision-1",
      dimensions: 3,
      modelSHA256: "a".repeat(64),
      tokenizerSHA256: "b".repeat(64),
      pooling: "mean",
      normalization: "l2",
      fingerprint: "c".repeat(64),
    },
    requestTimeoutMs: 1000,
    startupTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    idleTimeoutMs: 60_000,
    maxCrashRestarts: 3,
    crashBackoffMs: [1, 2, 3],
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
