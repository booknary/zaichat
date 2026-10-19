import { BundledArtifactSource } from "../src/semantic/bundledArtifactSource";
import {
  SemanticArtifactManager,
  SemanticArtifactFile,
  SemanticArtifactSource,
  HTTPSemanticArtifactSource,
} from "../src/semantic/semanticArtifactManager";
import { ZoteroSemanticArtifactFileSystem } from "../src/semantic/zoteroSemanticArtifactFileSystem";
import { SEMANTIC_RUNTIME_MANIFEST } from "../src/semantic/releaseManifests";
import { e5Manifest } from "../src/semantic/modelCatalog";
import { SemanticRuntimeFactory } from "../src/semantic/semanticRuntimeFactory";
import { ZoteroSubprocessLauncher } from "../src/semantic/zoteroSubprocessLauncher";
import { NDJSONWorkerClient } from "../src/semantic/ndjsonWorkerClient";

describe("Bundled E5 deployment", function () {
  it("extracts and verifies the XPI worker then starts it without a Python installation", async function () {
    this.timeout(120000);
    const fs = new ZoteroSemanticArtifactFileSystem();
    const profile = String((Zotero as any).Profile.dir);
    const root = PathUtils.join(profile, `zaichat-bundled-test-${Date.now()}`);
    const artifacts = new SemanticArtifactManager(fs, root, "bundled-test");
    const packedXpi = Services.env.get("ZAICHAT_BUNDLED_XPI_TEST");
    const resourceRoot = packedXpi
      ? `jar:${Zotero.File.pathToFileURI(packedXpi)}!/`
      : (Zotero as any).ZaiChat.data.runtimeResourceRoot;
    const source = new BundledArtifactSource(resourceRoot);
    let client: NDJSONWorkerClient | undefined;
    try {
      const installed = await artifacts.install(SEMANTIC_RUNTIME_MANIFEST, source, {
        confirmed: true,
      });
      if (!installed.verified) throw new Error("Bundled worker checksum failed");
      const process = await new ZoteroSubprocessLauncher().launch({
        command: fs.join(installed.location, "zaichat-embedding-worker.exe"),
        arguments: [],
      });
      client = new NDJSONWorkerClient(process, 30000);
      const hello = await client.request({ command: "hello" });
      if (hello.runtimeVersion !== "0.8.0-worker.1")
        throw new Error("Unexpected bundled worker version");
      await client.request({ command: "shutdown" });
      await client.wait();
    } finally {
      await client?.kill(1000);
      await artifacts.deleteAllManagedData(true);
    }
  });

  it("deploys Small into an isolated directory and self-tests query and document vectors", async function () {
    const assets = Services.env.get("ZAICHAT_SMALL_TEST_ASSETS");
    const fullDownload = Services.env.get("ZAICHAT_NETWORK_PROBE") === "full";
    if (!assets && !fullDownload) return;
    this.timeout(fullDownload ? 600000 : 180000);
    const fs = new ZoteroSemanticArtifactFileSystem();
    const root = PathUtils.join(
      String((Zotero as any).Profile.dir),
      `zaichat-small-deploy-test-${Date.now()}`,
    );
    const artifacts = new SemanticArtifactManager(fs, root, "small-test");
    const remote: SemanticArtifactSource = {
      async *read(file: SemanticArtifactFile) {
        const path = PathUtils.join(
          assets,
          `multilingual-e5-small-0e60b8d9d216-${file.relativePath.replace(/\//g, "-")}`,
        );
        for (let offset = 0; offset < file.size; offset += 1024 * 1024)
          yield await IOUtils.read(path, {
            offset,
            maxBytes: Math.min(1024 * 1024, file.size - offset),
          });
      },
    };
    const source = new BundledArtifactSource(
      (Zotero as any).ZaiChat.data.runtimeResourceRoot,
      fullDownload ? new HTTPSemanticArtifactSource() : remote,
    );
    const factory = new SemanticRuntimeFactory(
      new ZoteroSubprocessLauncher(),
      artifacts,
      artifacts,
      SEMANTIC_RUNTIME_MANIFEST,
      e5Manifest("small"),
      { protocolVersion: 1, startupTimeoutMs: 120000 },
    );
    let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
    try {
      await artifacts.install(SEMANTIC_RUNTIME_MANIFEST, source, { confirmed: true });
      await artifacts.install(e5Manifest("small"), source, { confirmed: true });
      runtime = await factory.create();
      const query = await runtime.embedQuery("本地论文语义检索");
      const documents = await runtime.embedDocuments([
        "A paper about multilingual retrieval.",
      ]);
      if (query.length !== 384 || documents[0]?.length !== 384)
        throw new Error("Deployment vector dimensions failed");
    } finally {
      await runtime?.stop();
      await artifacts.deleteAllManagedData(true);
    }
  });
});
