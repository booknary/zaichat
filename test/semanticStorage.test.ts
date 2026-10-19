import { describe, expect, it } from "vitest";
import { SemanticIndexFileManager } from "../src/semantic/semanticIndexFileManager";
import { resolveSemanticStorage } from "../src/semantic/semanticStorage";
import { MemorySemanticFileSystem } from "./helpers/memorySemanticFileSystem";

describe("semantic storage management", () => {
  it("keeps the index in the profile while allowing a custom artifact root", () => {
    expect(resolveSemanticStorage("C:\\Profile")).toEqual({
      indexRoot: "C:\\Profile\\zaichat\\semantic",
      indexDatabasePath: "C:\\Profile\\zaichat\\semantic\\index.sqlite",
      artifactRoot: "C:\\Profile\\zaichat\\semantic-artifacts",
    });
    expect(resolveSemanticStorage("C:\\Profile", "D:\\Models").artifactRoot).toBe(
      "D:\\Models",
    );
    expect(() => resolveSemanticStorage("relative-profile")).toThrow("absolute path");
    expect(() => resolveSemanticStorage("C:\\Profile", "relative-models")).toThrow(
      "absolute path",
    );
    expect(resolveSemanticStorage("/").indexDatabasePath).toBe(
      "/zaichat/semantic/index.sqlite",
    );
    expect(() => resolveSemanticStorage("C:\\Profile", "D:\\")).toThrow(
      "filesystem root",
    );
    expect(() => resolveSemanticStorage("C:\\Profile", "C:\\Profile\\zaichat")).toThrow(
      "must not overlap",
    );
    expect(() =>
      resolveSemanticStorage("C:\\Profile", "C:\\Profile\\zaichat\\semantic\\models"),
    ).toThrow("must not overlap");
  });

  it("tracks database sidecars and clears only an owned index root", async () => {
    const fileSystem = new MemorySemanticFileSystem();
    const manager = new SemanticIndexFileManager(
      fileSystem,
      "/profile/zaichat/semantic",
      "installation-1",
    );
    await manager.prepare();
    await fileSystem.put(manager.getDatabasePath(), new Uint8Array(10));
    await fileSystem.put(`${manager.getDatabasePath()}-wal`, new Uint8Array(7));
    await fileSystem.put(`${manager.getDatabasePath()}-shm`, new Uint8Array(3));

    expect(await manager.inspect()).toMatchObject({
      installed: true,
      verified: true,
      diskUsage: 20,
    });
    await expect(manager.clear(false)).rejects.toThrow("requires confirmation");
    await manager.clear(true);
    expect(await manager.inspect()).toMatchObject({
      installed: false,
      verified: true,
      diskUsage: 0,
    });
    await manager.deleteAll(true);
    expect(await manager.inspect()).toMatchObject({
      installed: false,
      verified: false,
      diskUsage: 0,
    });
  });

  it("refuses to adopt or delete an unmarked existing directory", async () => {
    const fileSystem = new MemorySemanticFileSystem();
    await fileSystem.put("/foreign/index.sqlite", new Uint8Array(4));
    const manager = new SemanticIndexFileManager(
      fileSystem,
      "/foreign",
      "installation-1",
    );

    await expect(manager.prepare()).rejects.toThrow("marker is missing");
    await expect(manager.clear(true)).rejects.toThrow("marker is missing");
    await expect(manager.deleteAll(true)).rejects.toThrow("marker is missing");
    expect(await fileSystem.fileSize("/foreign/index.sqlite")).toBe(4);
  });
});
