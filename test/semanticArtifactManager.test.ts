import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SemanticArtifactFile,
  SemanticArtifactFileSystem,
  SemanticArtifactManager,
  SemanticArtifactManifest,
  SemanticArtifactSource,
  SemanticDownloadError,
} from "../src/semantic/semanticArtifactManager";
import { SemanticRuntimeFactory } from "../src/semantic/semanticRuntimeFactory";

describe("SemanticArtifactManager", () => {
  it("retries one interrupted file from scratch and verifies the final bytes", async () => {
    const fs = new MemoryFileSystem();
    const bytes = new TextEncoder().encode("model bytes");
    const manager = new SemanticArtifactManager(fs, "/models", "z1");
    let calls = 0;
    const source: SemanticArtifactSource = {
      async *read() {
        calls++;
        if (calls === 1) {
          yield bytes.slice(0, 2);
          throw new SemanticDownloadError("Network interrupted", true);
        }
        yield bytes;
      },
    };
    expect(
      (await manager.install(createManifest(bytes), source, { confirmed: true }))
        .verified,
    ).toBe(true);
    expect(calls).toBe(2);
  });
  it("accepts transport changes but never changed file identity", async () => {
    const fs = new MemoryFileSystem();
    const bytes = new TextEncoder().encode("model bytes");
    const original = createManifest(bytes);
    const manager = new SemanticArtifactManager(fs, "/models", "z1");
    await manager.install(original, new MemorySource(bytes), { confirmed: true });
    const moved = {
      ...original,
      files: original.files.map((file) => ({
        ...file,
        url: "https://huggingface.co/new-location",
      })),
    };
    expect((await manager.inspect(moved)).verified).toBe(true);
    moved.files[0].sha256 = "a".repeat(64);
    expect((await manager.inspect(moved)).verified).toBe(false);
  });

  it("reports bounded progress and rejects oversized downloads", async () => {
    const fs = new MemoryFileSystem();
    const bytes = new TextEncoder().encode("data");
    const manager = new SemanticArtifactManager(fs, "/models", "z1");
    const progress: number[] = [];
    await manager.install(createManifest(bytes), new MemorySource(bytes), {
      confirmed: true,
      onProgress: (received) => progress.push(received),
    });
    expect(progress.at(-1)).toBe(bytes.length);
    const another = new SemanticArtifactManager(fs, "/other", "z1");
    await expect(
      another.install(createManifest(bytes), new MemorySource(new Uint8Array(5)), {
        confirmed: true,
      }),
    ).rejects.toThrow("exceeds expected size");
    expect(fs.paths().some((path) => path.includes(".staging-"))).toBe(false);
  });

  it("rejects insufficient storage before requesting a model", async () => {
    const fs = new MemoryFileSystem();
    (fs as any).availableBytes = async () => 1;
    const bytes = new TextEncoder().encode("model");
    const manager = new SemanticArtifactManager(fs, "/models", "z1");
    await expect(
      manager.install(createManifest(bytes), new MemorySource(bytes), {
        confirmed: true,
      }),
    ).rejects.toThrow("free disk space");
    expect(fs.paths().some((path) => path.includes(".staging-"))).toBe(false);
  });

  it("installs only after confirmation and verifies every downloaded file", async () => {
    const fileSystem = new MemoryFileSystem();
    const bytes = new TextEncoder().encode("verified model bytes");
    const manifest = createManifest(bytes);
    const manager = new SemanticArtifactManager(fileSystem, "/external/models", "z1");
    const source = new MemorySource(bytes);

    await expect(
      manager.install(manifest, source, { confirmed: false }),
    ).rejects.toThrow("user confirmation");
    const installed = await manager.install(manifest, source, { confirmed: true });

    expect(installed.verified).toBe(true);
    expect(installed.diskUsage).toBe(bytes.byteLength);
    expect(installed.location).toContain("/external/models/model/");
    expect(await manager.inspect(manifest)).toEqual(installed);
  });

  it("rejects checksum failures and cleans the staging directory", async () => {
    const fileSystem = new MemoryFileSystem();
    const expected = new TextEncoder().encode("expected");
    const manager = new SemanticArtifactManager(fileSystem, "/models", "z1");

    await expect(
      manager.install(createManifest(expected), new MemorySource(new Uint8Array(8)), {
        confirmed: true,
      }),
    ).rejects.toThrow("checksum mismatch");
    expect(fileSystem.paths().some((path) => path.includes(".staging-"))).toBe(false);
  });

  it("requires the installation marker before deleting model data", async () => {
    const fileSystem = new MemoryFileSystem();
    const bytes = new TextEncoder().encode("model");
    const manifest = createManifest(bytes);
    const manager = new SemanticArtifactManager(fileSystem, "/models", "z1");
    await manager.install(manifest, new MemorySource(bytes), { confirmed: true });

    await fileSystem.writeText(
      "/models/.zaichat-semantic-model-root",
      JSON.stringify({ installationID: "another", formatVersion: 1 }),
    );
    await expect(manager.delete(manifest, true)).rejects.toThrow(
      "another installation",
    );
    expect((await manager.inspect(manifest)).installed).toBe(true);
  });

  it("deletes only the exact manifest-owned package after confirmation", async () => {
    const fileSystem = new MemoryFileSystem();
    const bytes = new TextEncoder().encode("model");
    const manifest = createManifest(bytes);
    const manager = new SemanticArtifactManager(fileSystem, "/models", "z1");
    await manager.install(manifest, new MemorySource(bytes), { confirmed: true });

    await expect(manager.delete(manifest, false)).rejects.toThrow("user confirmation");
    await manager.delete(manifest, true);
    expect((await manager.inspect(manifest)).installed).toBe(false);
  });

  it("rejects path traversal before writing anything", async () => {
    const fileSystem = new MemoryFileSystem();
    const bytes = new TextEncoder().encode("model");
    const manifest = createManifest(bytes);
    manifest.files[0].relativePath = "../outside.bin";
    const manager = new SemanticArtifactManager(fileSystem, "/models", "z1");

    await expect(
      manager.install(manifest, new MemorySource(bytes), { confirmed: true }),
    ).rejects.toThrow("Unsafe semantic artifact path");
    expect(fileSystem.paths()).toEqual([]);
  });

  it("creates a stopped runtime only from two verified packages", async () => {
    const fileSystem = new MemoryFileSystem();
    const runtimeBytes = new TextEncoder().encode("runtime");
    const modelBytes = new TextEncoder().encode("model");
    const runtimeManifest = createManifest(runtimeBytes);
    runtimeManifest.packageType = "runtime";
    runtimeManifest.packageID = "zaichat/worker";
    runtimeManifest.files[0].relativePath = "worker.exe";
    runtimeManifest.files[0].executable = true;
    const modelManifest = createManifest(modelBytes);
    modelManifest.model = {
      modelID: "intfloat/multilingual-e5-small",
      version: "revision-1",
      dimensions: 384,
      modelSHA256: "a".repeat(64),
      tokenizerSHA256: "b".repeat(64),
      pooling: "mean",
      normalization: "l2",
      fingerprint: "c".repeat(64),
    };
    const runtimeArtifacts = new SemanticArtifactManager(fileSystem, "/runtime", "z1");
    const modelArtifacts = new SemanticArtifactManager(fileSystem, "/models", "z1");
    const factory = new SemanticRuntimeFactory(
      { launch: async () => Promise.reject(new Error("not started")) },
      runtimeArtifacts,
      modelArtifacts,
      runtimeManifest,
      modelManifest,
      { protocolVersion: 1 },
    );

    await expect(factory.create()).rejects.toThrow("runtime is not installed");
    await runtimeArtifacts.install(runtimeManifest, new MemorySource(runtimeBytes), {
      confirmed: true,
    });
    await modelArtifacts.install(modelManifest, new MemorySource(modelBytes), {
      confirmed: true,
    });
    const manager = await factory.create();
    expect(manager.getStatus()).toMatchObject({ state: "stopped", crashCount: 0 });
  });
});

class MemorySource implements SemanticArtifactSource {
  constructor(private readonly bytes: Uint8Array) {}

  async *read(_file: SemanticArtifactFile): AsyncIterable<Uint8Array> {
    const middle = Math.floor(this.bytes.byteLength / 2);
    yield this.bytes.slice(0, middle);
    yield this.bytes.slice(middle);
  }
}

class MemoryFileSystem implements SemanticArtifactFileSystem {
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>();

  join(...parts: string[]): string {
    return normalize(parts.join("/"));
  }

  parent(path: string): string {
    const value = normalize(path);
    const index = value.lastIndexOf("/");
    if (index <= 0) return "/";
    return value.slice(0, index);
  }

  async exists(path: string): Promise<boolean> {
    const value = normalize(path);
    return this.files.has(value) || this.directories.has(value);
  }

  async mkdir(path: string): Promise<void> {
    let current = "";
    for (const part of normalize(path).split("/").filter(Boolean)) {
      current += `/${part}`;
      this.directories.add(current);
    }
  }

  async readText(path: string): Promise<string> {
    const value = this.files.get(normalize(path));
    if (!value) throw new Error("missing file");
    return new TextDecoder().decode(value);
  }

  async writeText(path: string, value: string): Promise<void> {
    await this.mkdir(this.parent(path));
    this.files.set(normalize(path), new TextEncoder().encode(value));
  }

  async writeChunks(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const values: number[] = [];
    for await (const chunk of chunks) values.push(...chunk);
    await this.mkdir(this.parent(path));
    this.files.set(normalize(path), new Uint8Array(values));
  }

  async move(source: string, destination: string): Promise<void> {
    const from = normalize(source);
    const to = normalize(destination);
    if (await this.exists(to)) throw new Error("destination exists");
    await this.mkdir(this.parent(to));
    for (const [path, value] of [...this.files]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.files.delete(path);
        this.files.set(`${to}${path.slice(from.length)}`, value);
      }
    }
    for (const path of [...this.directories]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.directories.delete(path);
        this.directories.add(`${to}${path.slice(from.length)}`);
      }
    }
  }

  async removeTree(path: string): Promise<void> {
    const root = normalize(path);
    for (const value of [...this.files.keys()])
      if (value === root || value.startsWith(`${root}/`)) this.files.delete(value);
    for (const value of [...this.directories])
      if (value === root || value.startsWith(`${root}/`))
        this.directories.delete(value);
  }

  async fileSize(path: string): Promise<number> {
    const value = this.files.get(normalize(path));
    if (!value) throw new Error("missing file");
    return value.byteLength;
  }

  async sha256(path: string): Promise<string> {
    const value = this.files.get(normalize(path));
    if (!value) throw new Error("missing file");
    return createHash("sha256").update(value).digest("hex");
  }

  paths(): string[] {
    return [...this.files.keys(), ...this.directories].sort();
  }
}

function createManifest(bytes: Uint8Array): SemanticArtifactManifest {
  return {
    formatVersion: 1,
    packageType: "model",
    packageID: "intfloat/multilingual-e5-small",
    version: "revision-1",
    platform: "win-x64",
    files: [
      {
        relativePath: "onnx/model.onnx",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        url: "https://models.example.invalid/model.onnx",
      },
    ],
  };
}

function normalize(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}
