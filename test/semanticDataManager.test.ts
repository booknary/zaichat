import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createModelFingerprint } from "../src/semantic/fingerprint";
import {
  SemanticArtifactFile,
  SemanticArtifactManager,
  SemanticArtifactManifest,
  SemanticArtifactSource,
} from "../src/semantic/semanticArtifactManager";
import { SemanticDataManager } from "../src/semantic/semanticDataManager";
import { SemanticIndexFileManager } from "../src/semantic/semanticIndexFileManager";
import { PaperSemanticSubsystemStatus } from "../src/semantic/paperSemanticSubsystem";
import { MemorySemanticFileSystem } from "./helpers/memorySemanticFileSystem";

describe("SemanticDataManager", () => {
  it("installs verified packages only after confirmation and reports storage", async () => {
    const fixture = await createFixture();

    await expect(fixture.manager.installRequired(false)).rejects.toThrow(
      "requires confirmation",
    );
    expect(fixture.fileSystem.paths()).toEqual([]);

    const status = await fixture.manager.installRequired(true);
    expect(status).toMatchObject({
      runtime: { installed: true, verified: true, diskUsage: 7 },
      model: { installed: true, verified: true, diskUsage: 5 },
      subsystem: { state: "ready" },
      totalDiskUsage: 12,
    });
    expect(fixture.subsystem.started).toBe(1);
  });

  it("clears the index only after stopping the subsystem", async () => {
    const fixture = await createFixture();
    await fixture.indexFiles.prepare();
    await fixture.fileSystem.put(
      fixture.indexFiles.getDatabasePath(),
      new Uint8Array(11),
    );
    fixture.subsystem.status = { state: "ready" };

    expect(await fixture.manager.inspect()).toMatchObject({
      index: { installed: true, verified: true, diskUsage: 11, vectorCount: 9 },
    });
    await expect(fixture.manager.clearIndex(false)).rejects.toThrow(
      "requires confirmation",
    );
    await fixture.manager.clearIndex(true);

    expect(fixture.subsystem.stopped).toBe(1);
    expect(await fixture.indexFiles.inspect()).toMatchObject({
      installed: false,
      verified: true,
      diskUsage: 0,
    });
  });

  it("rebuilds through the subsystem lifecycle without touching artifacts", async () => {
    const fixture = await createFixture();
    await fixture.manager.rebuildIndex();

    expect(fixture.subsystem.started).toBe(1);
    expect(fixture.subsystem.rebuilt).toBe(1);
    expect(fixture.subsystem.waited).toBe(2);
  });

  it("allows an indexing failure to be replaced by a new generation", async () => {
    const fixture = await createFixture();
    fixture.subsystem.status = { state: "failed", failure: "indexing failed" };
    fixture.subsystem.keepStatusOnStart = true;

    await fixture.manager.rebuildIndex();

    expect(fixture.subsystem.rebuilt).toBe(1);
    expect(fixture.subsystem.waited).toBe(2);
  });

  it("deletes one model or every owned semantic root with explicit confirmation", async () => {
    const fixture = await createFixture();
    await fixture.manager.installRequired(true, { startAfterInstall: false });
    await fixture.indexFiles.prepare();
    await fixture.fileSystem.put(
      fixture.indexFiles.getDatabasePath(),
      new Uint8Array(3),
    );

    await expect(fixture.manager.deleteModel(false)).rejects.toThrow(
      "requires confirmation",
    );
    let status = await fixture.manager.deleteModel(true);
    expect(status.model.installed).toBe(false);
    expect(status.runtime.installed).toBe(true);

    await fixture.manager.installRequired(true, { startAfterInstall: false });
    await expect(fixture.manager.deleteAllSemanticData(false)).rejects.toThrow(
      "requires confirmation",
    );
    status = await fixture.manager.deleteAllSemanticData(true);
    expect(status).toMatchObject({
      runtime: { installed: false },
      model: { installed: false },
      index: { installed: false, diskUsage: 0 },
      totalDiskUsage: 0,
    });
    expect(fixture.fileSystem.paths()).not.toContain("/artifacts");
    expect(fixture.fileSystem.paths()).not.toContain("/index");
  });
});

async function createFixture() {
  const fileSystem = new MemorySemanticFileSystem();
  const runtimeBytes = new Uint8Array(7).fill(1);
  const modelBytes = new Uint8Array(5).fill(2);
  const model = await createModelFingerprint({
    modelID: "intfloat/multilingual-e5-small",
    version: "revision-1",
    dimensions: 384,
    modelSHA256: hash(modelBytes),
    tokenizerSHA256: "b".repeat(64),
    pooling: "mean",
    normalization: "l2",
  });
  const runtimeManifest: SemanticArtifactManifest = {
    formatVersion: 1,
    packageType: "runtime",
    packageID: "zaichat/worker",
    version: "0.8.0-worker.1",
    platform: "win-x64",
    files: [artifact("worker.exe", runtimeBytes, true)],
  };
  const modelManifest: SemanticArtifactManifest = {
    formatVersion: 1,
    packageType: "model",
    packageID: model.modelID,
    version: model.version,
    platform: "win-x64",
    files: [artifact("onnx/model.onnx", modelBytes)],
    model,
  };
  const runtimeArtifacts = new SemanticArtifactManager(
    fileSystem,
    "/artifacts",
    "installation-1",
  );
  const modelArtifacts = new SemanticArtifactManager(
    fileSystem,
    "/artifacts",
    "installation-1",
  );
  const indexFiles = new SemanticIndexFileManager(
    fileSystem,
    "/index",
    "installation-1",
  );
  const subsystem = new FakeSubsystem();
  const manager = new SemanticDataManager({
    runtimeArtifacts,
    modelArtifacts,
    runtimeManifest,
    modelManifest,
    artifactSource: new MemorySource(
      new Map([
        ["worker.exe", runtimeBytes],
        ["onnx/model.onnx", modelBytes],
      ]),
    ),
    indexFiles,
    subsystem,
    inspectVectorCount: async () => 9,
  });
  return { manager, fileSystem, indexFiles, subsystem };
}

class FakeSubsystem {
  status: PaperSemanticSubsystemStatus = { state: "stopped" };
  keepStatusOnStart = false;
  started = 0;
  stopped = 0;
  waited = 0;
  rebuilt = 0;
  paused = 0;
  resumed = 0;
  cancelled = 0;

  getStatus(): PaperSemanticSubsystemStatus {
    return { ...this.status };
  }

  async start(): Promise<PaperSemanticSubsystemStatus> {
    this.started += 1;
    if (this.keepStatusOnStart) return this.getStatus();
    this.status = {
      state: "ready",
      indexing: {
        state: "completed",
        totalItems: 2,
        completedItems: 2,
        vectorCount: 6,
        recovered: false,
      },
    };
    return this.getStatus();
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.status = { state: "stopped" };
  }

  async waitForIndexing(): Promise<void> {
    this.waited += 1;
  }

  async rebuildIndex(): Promise<void> {
    this.rebuilt += 1;
  }

  async pauseIndexing(): Promise<void> {
    this.paused += 1;
  }

  async resumeIndexing(): Promise<void> {
    this.resumed += 1;
  }

  async cancelIndexing(): Promise<void> {
    this.cancelled += 1;
  }

  async searchPapers(): Promise<[]> {
    return [];
  }
}

class MemorySource implements SemanticArtifactSource {
  constructor(private readonly files: Map<string, Uint8Array>) {}

  async *read(file: SemanticArtifactFile): AsyncIterable<Uint8Array> {
    const value = this.files.get(file.relativePath);
    if (!value) throw new Error("missing source artifact");
    yield value.slice();
  }
}

function artifact(
  relativePath: string,
  bytes: Uint8Array,
  executable = false,
): SemanticArtifactFile {
  return {
    relativePath,
    size: bytes.byteLength,
    sha256: hash(bytes),
    url: `https://downloads.example.invalid/${relativePath}`,
    ...(executable ? { executable: true } : {}),
  };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
