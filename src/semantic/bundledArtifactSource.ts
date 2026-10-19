import {
  HTTPSemanticArtifactSource,
  SemanticArtifactFile,
  SemanticArtifactSource,
} from "./semanticArtifactManager";
import { SEMANTIC_MODEL_MANIFEST, SEMANTIC_RUNTIME_MANIFEST } from "./releaseManifests";

/** Only the two pinned release assets may be read from the installed XPI. */
export class BundledArtifactSource implements SemanticArtifactSource {
  constructor(
    private readonly pluginRoot: string,
    private readonly remote: SemanticArtifactSource = new HTTPSemanticArtifactSource(),
  ) {}

  async *read(
    file: SemanticArtifactFile,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const pinned = [
      SEMANTIC_RUNTIME_MANIFEST.files[0],
      SEMANTIC_MODEL_MANIFEST.files.find(
        (entry) => entry.relativePath === "THIRD_PARTY_NOTICES.txt",
      )!,
    ];
    const match = pinned.find(
      (entry) =>
        entry.relativePath === file.relativePath &&
        entry.sha256 === file.sha256 &&
        entry.size === file.size,
    );
    if (!match) {
      yield* this.remote.read(file, signal);
      return;
    }
    if (signal?.aborted) throw new Error("Semantic installation cancelled");
    let response: Response;
    try {
      response = await fetch(
        `${this.pluginRoot}content/runtime/${match.relativePath}`,
        { signal },
      );
    } catch {
      throw new Error(
        `读取插件内置文件失败：${match.relativePath}。请重新安装完整 XPI；此步骤不需要联网。`,
      );
    }
    if (!response.ok) throw new Error("Bundled runtime asset could not be read");
    // The bundled executable is bounded to 44 MB. Models always use streaming HTTPS.
    yield new Uint8Array(await response.arrayBuffer());
  }
}
