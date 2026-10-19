import {
  HTTPSemanticArtifactSource,
  SemanticArtifactManager,
  SemanticArtifactManifest,
} from "./semanticArtifactManager";
import { SemanticDataManager } from "./semanticDataManager";
import { SemanticIndexFileManager } from "./semanticIndexFileManager";
import { SemanticIndexStore } from "./semanticIndexStore";
import { createZoteroPaperSemanticSubsystem } from "./paperSemanticSubsystem";
import { SemanticRuntimeFactory } from "./semanticRuntimeFactory";
import { resolveSemanticStorage } from "./semanticStorage";
import { PAPER_NAMESPACE } from "./types";
import { ZoteroSemanticArtifactFileSystem } from "./zoteroSemanticArtifactFileSystem";
import { ZoteroSemanticDatabase } from "./zoteroSemanticDatabase";
import { ZoteroSubprocessLauncher } from "./zoteroSubprocessLauncher";
import {
  JSONAbstractEnrichmentCache,
  OpenAlexAbstractEnricher,
} from "./openAlexAbstractEnricher";
import { ZoteroPaperSourceProvider } from "./zoteroPaperSourceProvider";
import { BundledArtifactSource } from "./bundledArtifactSource";
import { E5_MODEL_IDS, e5Manifest, modelIndexRoot } from "./modelCatalog";

const INSTALLATION_ID = "zaichat@booknary.github.io";

export interface ZoteroSemanticDataManagerOptions {
  profileDirectory: string;
  customArtifactRoot?: string;
  runtimeManifest: SemanticArtifactManifest;
  modelManifest: SemanticArtifactManifest;
  protocolVersion?: number;
  enrichMissingAbstracts?: () => boolean;
  pluginRoot?: string;
}

export function createZoteroSemanticDataManager(
  options: ZoteroSemanticDataManagerOptions,
): SemanticDataManager {
  const layout = resolveSemanticStorage(
    options.profileDirectory,
    options.customArtifactRoot,
    (...parts) => PathUtils.join(...parts),
  );
  const fileSystem = new ZoteroSemanticArtifactFileSystem();
  const indexRoot = modelIndexRoot(
    options.profileDirectory,
    options.modelManifest,
    (...parts) => PathUtils.join(...parts),
  );
  const runtimeArtifacts = new SemanticArtifactManager(
    fileSystem,
    layout.artifactRoot,
    INSTALLATION_ID,
  );
  const modelArtifacts = new SemanticArtifactManager(
    fileSystem,
    layout.artifactRoot,
    INSTALLATION_ID,
  );
  const indexFiles = new SemanticIndexFileManager(
    fileSystem,
    indexRoot,
    INSTALLATION_ID,
  );
  const runtimeFactory = new SemanticRuntimeFactory(
    new ZoteroSubprocessLauncher(),
    runtimeArtifacts,
    modelArtifacts,
    options.runtimeManifest,
    options.modelManifest,
    {
      protocolVersion: options.protocolVersion ?? 1,
      startupTimeoutMs: 180_000,
      requestTimeoutMs: 120_000,
    },
  );
  const abstractEnricher = new OpenAlexAbstractEnricher(
    new JSONAbstractEnrichmentCache(
      fileSystem,
      fileSystem.join(indexRoot, "abstract-enrichment.json"),
    ),
    { enabled: options.enrichMissingAbstracts || (() => false) },
  );
  const subsystem = createZoteroPaperSemanticSubsystem(
    options.profileDirectory,
    runtimeFactory,
    new ZoteroPaperSourceProvider(abstractEnricher),
    indexRoot,
  );
  return new SemanticDataManager({
    runtimeArtifacts,
    modelArtifacts,
    runtimeManifest: options.runtimeManifest,
    modelManifest: options.modelManifest,
    artifactSource: options.pluginRoot
      ? new BundledArtifactSource(options.pluginRoot)
      : new HTTPSemanticArtifactSource(),
    indexFiles,
    subsystem,
    inspectVectorCount: () => inspectVectorCount(indexFiles),
    probeRuntime: async () => {
      const runtime = await runtimeFactory.create();
      try {
        await runtime.embedQuery("Local multilingual embedding self-test 本地向量测试");
        await runtime.embedDocuments(["A synthetic paper about local indexing."]);
      } finally {
        await runtime.stop();
      }
    },
    additionalIndexFiles: E5_MODEL_IDS.map((id) =>
      modelIndexRoot(options.profileDirectory, e5Manifest(id), (...parts) =>
        PathUtils.join(...parts),
      ),
    )
      .filter((path) => path !== indexRoot)
      .map((path) => new SemanticIndexFileManager(fileSystem, path, INSTALLATION_ID)),
  });
}

async function inspectVectorCount(
  indexFiles: SemanticIndexFileManager,
): Promise<number> {
  const status = await indexFiles.inspect();
  if (!status.installed || !status.verified) return 0;
  const store = new SemanticIndexStore(
    await ZoteroSemanticDatabase.open(status.databasePath),
  );
  try {
    await store.initialize();
    return (await store.getActiveGeneration(PAPER_NAMESPACE))?.recordCount || 0;
  } finally {
    await store.close();
  }
}
