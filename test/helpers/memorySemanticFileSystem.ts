import { createHash } from "node:crypto";
import { SemanticArtifactFileSystem } from "../../src/semantic/semanticArtifactManager";

export class MemorySemanticFileSystem implements SemanticArtifactFileSystem {
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>();

  join(...parts: string[]): string {
    return normalize(parts.join("/"));
  }

  parent(path: string): string {
    const normalized = normalize(path);
    const index = normalized.lastIndexOf("/");
    if (index <= 0) throw new Error("path has no parent");
    return normalized.slice(0, index);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalize(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalize(path);
    const parts = normalized.split("/").filter(Boolean);
    let current = normalized.startsWith("/") ? "" : undefined;
    for (const part of parts) {
      current = current === "" ? `/${part}` : current ? `${current}/${part}` : part;
      this.directories.add(current);
    }
  }

  async readText(path: string): Promise<string> {
    const value = this.files.get(normalize(path));
    if (!value) throw new Error("missing file");
    return new TextDecoder().decode(value);
  }

  async writeText(path: string, value: string): Promise<void> {
    await this.put(path, new TextEncoder().encode(value));
  }

  async writeChunks(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const values: number[] = [];
    for await (const chunk of chunks) values.push(...chunk);
    await this.put(path, new Uint8Array(values));
  }

  async move(source: string, destination: string): Promise<void> {
    const from = normalize(source);
    const to = normalize(destination);
    if (await this.exists(to)) throw new Error("destination exists");
    const movedFiles = [...this.files.entries()].filter(
      ([path]) => path === from || path.startsWith(`${from}/`),
    );
    const movedDirectories = [...this.directories].filter(
      (path) => path === from || path.startsWith(`${from}/`),
    );
    for (const [path, value] of movedFiles) {
      this.files.delete(path);
      this.files.set(`${to}${path.slice(from.length)}`, value);
    }
    for (const path of movedDirectories) {
      this.directories.delete(path);
      this.directories.add(`${to}${path.slice(from.length)}`);
    }
  }

  async removeTree(path: string): Promise<void> {
    const root = normalize(path);
    for (const file of [...this.files.keys()])
      if (file === root || file.startsWith(`${root}/`)) this.files.delete(file);
    for (const directory of [...this.directories])
      if (directory === root || directory.startsWith(`${root}/`))
        this.directories.delete(directory);
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

  async put(path: string, value: Uint8Array): Promise<void> {
    await this.mkdir(this.parent(path));
    this.files.set(normalize(path), value.slice());
  }

  paths(): string[] {
    return [...this.files.keys(), ...this.directories].sort();
  }
}

function normalize(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}
