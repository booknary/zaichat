import { SemanticArtifactFileSystem } from "./semanticArtifactManager";

export class ZoteroSemanticArtifactFileSystem implements SemanticArtifactFileSystem {
  async availableBytes(path: string): Promise<number> {
    const file = (Components as any).classes[
      "@mozilla.org/file/local;1"
    ].createInstance((Components as any).interfaces.nsIFile);
    file.initWithPath(path);
    const available = Number(file.diskSpaceAvailable);
    if (!Number.isFinite(available) || available < 0)
      throw new Error("Cannot determine available semantic storage space");
    return available;
  }
  join(...parts: string[]): string {
    return PathUtils.join(...parts);
  }

  parent(path: string): string {
    const parent = PathUtils.parent(path);
    if (!parent) throw new Error("Semantic artifact path has no parent");
    return parent;
  }

  exists(path: string): Promise<boolean> {
    return IOUtils.exists(path);
  }

  async mkdir(path: string): Promise<void> {
    await IOUtils.makeDirectory(path, { createAncestors: true, ignoreExisting: true });
  }

  readText(path: string): Promise<string> {
    return IOUtils.readUTF8(path);
  }

  async writeText(path: string, value: string): Promise<void> {
    await IOUtils.writeUTF8(path, value);
  }

  async writeChunks(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    let first = true;
    for await (const chunk of chunks) {
      await (IOUtils.write as any)(path, chunk, {
        mode: first ? "overwrite" : "append",
      });
      first = false;
    }
    if (first)
      await (IOUtils.write as any)(path, new Uint8Array(), { mode: "overwrite" });
  }

  async move(source: string, destination: string): Promise<void> {
    await IOUtils.move(source, destination, { noOverwrite: true });
  }

  async removeTree(path: string): Promise<void> {
    await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
  }

  async fileSize(path: string): Promise<number> {
    const stat = await IOUtils.stat(path);
    if (typeof stat.size !== "number")
      throw new Error("Semantic artifact path is not a regular file");
    return stat.size;
  }

  async sha256(path: string): Promise<string> {
    const classes = (Components as any).classes;
    const interfaces = (Components as any).interfaces;
    const file = classes["@mozilla.org/file/local;1"].createInstance(
      interfaces.nsIFile,
    );
    file.initWithPath(path);
    const stream = classes["@mozilla.org/network/file-input-stream;1"].createInstance(
      interfaces.nsIFileInputStream,
    );
    stream.init(file, 0x01, 0, 0);
    try {
      const hash = classes["@mozilla.org/security/hash;1"].createInstance(
        interfaces.nsICryptoHash,
      );
      hash.init(hash.SHA256);
      hash.updateFromStream(stream, -1);
      return [...hash.finish(false)]
        .map((character: string) =>
          character.charCodeAt(0).toString(16).padStart(2, "0"),
        )
        .join("");
    } finally {
      stream.close();
    }
  }
}
