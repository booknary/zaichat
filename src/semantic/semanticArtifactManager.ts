import { SemanticModelFingerprint } from "./types";

const ROOT_MARKER = ".zaichat-semantic-model-root";
const MANIFEST_FILE = "manifest.json";

export interface SemanticArtifactFile {
  relativePath: string;
  size: number;
  sha256: string;
  url: string;
  executable?: boolean;
}

export interface SemanticArtifactManifest {
  formatVersion: 1;
  packageType: "model" | "runtime";
  packageID: string;
  version: string;
  platform: "win-x64";
  files: SemanticArtifactFile[];
  model?: SemanticModelFingerprint;
}

export interface SemanticArtifactSource {
  read(file: SemanticArtifactFile, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface SemanticArtifactFileSystem {
  join(...parts: string[]): string;
  parent(path: string): string;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, value: string): Promise<void>;
  writeChunks(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void>;
  move(source: string, destination: string): Promise<void>;
  removeTree(path: string): Promise<void>;
  fileSize(path: string): Promise<number>;
  sha256(path: string): Promise<string>;
  availableBytes?(path: string): Promise<number>;
}

export interface SemanticArtifactStatus {
  installed: boolean;
  verified: boolean;
  location: string;
  expectedSize: number;
  diskUsage: number;
  failure?: string;
}

export class SemanticArtifactManager {
  constructor(
    private readonly fileSystem: SemanticArtifactFileSystem,
    private readonly rootDirectory: string,
    private readonly installationID: string,
  ) {
    if (!rootDirectory.trim()) throw new Error("Semantic artifact root is required");
    if (!installationID.trim())
      throw new Error("Semantic artifact installation ID is required");
  }

  getLocation(manifest: SemanticArtifactManifest): string {
    validateManifest(manifest);
    return this.fileSystem.join(
      this.rootDirectory,
      safeComponent(manifest.packageType),
      safeComponent(manifest.packageID),
      safeComponent(manifest.version),
    );
  }

  async inspect(manifest: SemanticArtifactManifest): Promise<SemanticArtifactStatus> {
    const location = this.getLocation(manifest);
    const expectedSize = totalSize(manifest);
    if (!(await this.fileSystem.exists(location)))
      return {
        installed: false,
        verified: false,
        location,
        expectedSize,
        diskUsage: 0,
      };
    try {
      await this.verifyManagedRoot();
      await this.verifyInstalledManifest(location, manifest);
      let diskUsage = 0;
      for (const file of manifest.files) {
        const path = artifactPath(this.fileSystem, location, file.relativePath);
        const size = await this.fileSystem.fileSize(path);
        if (size !== file.size)
          throw new Error(`Artifact size mismatch: ${file.relativePath}`);
        const digest = (await this.fileSystem.sha256(path)).toLocaleLowerCase();
        if (digest !== file.sha256.toLocaleLowerCase())
          throw new Error(`Artifact checksum mismatch: ${file.relativePath}`);
        diskUsage += size;
      }
      return { installed: true, verified: true, location, expectedSize, diskUsage };
    } catch (error) {
      return {
        installed: true,
        verified: false,
        location,
        expectedSize,
        diskUsage: 0,
        failure: safeError(error),
      };
    }
  }

  async install(
    manifest: SemanticArtifactManifest,
    source: SemanticArtifactSource,
    options: {
      confirmed: boolean;
      signal?: AbortSignal;
      onProgress?: (received: number, total: number, file: string) => void;
    },
  ): Promise<SemanticArtifactStatus> {
    validateManifest(manifest);
    if (!options.confirmed)
      throw new Error("Semantic artifact installation requires user confirmation");
    await this.ensureManagedRoot();
    const existing = await this.inspect(manifest);
    if (existing.installed) {
      if (!existing.verified)
        throw new Error(
          "Existing semantic artifact is damaged; delete it before retrying",
        );
      return existing;
    }
    const destination = this.getLocation(manifest);
    const freeBytes = await this.fileSystem.availableBytes?.(this.rootDirectory);
    if (freeBytes !== undefined && freeBytes < totalSize(manifest) + 64 * 1024 * 1024)
      throw new Error(
        "Not enough free disk space for this semantic package and temporary installation files",
      );
    const staging = this.fileSystem.join(
      this.rootDirectory,
      `.staging-${safeComponent(manifest.packageID)}-${Date.now()}`,
    );
    await this.fileSystem.mkdir(staging);
    let received = 0;
    try {
      for (const file of manifest.files) {
        if (options.signal?.aborted)
          throw new Error("Semantic artifact download cancelled");
        const path = artifactPath(this.fileSystem, staging, file.relativePath);
        await this.fileSystem.mkdir(this.fileSystem.parent(path));
        const chunks = async function* () {
          let fileReceived = 0;
          for await (const chunk of source.read(file, options.signal)) {
            if (options.signal?.aborted)
              throw new Error("Semantic artifact download cancelled");
            fileReceived += chunk.byteLength;
            if (fileReceived > file.size)
              throw new Error(
                `Downloaded artifact exceeds expected size: ${file.relativePath}`,
              );
            received += chunk.byteLength;
            options.onProgress?.(received, totalSize(manifest), file.relativePath);
            yield chunk;
          }
        };
        const beforeFile = received;
        for (let attempt = 0; ; attempt++) {
          try {
            await this.fileSystem.writeChunks(path, chunks());
            break;
          } catch (error) {
            if (
              !(error instanceof SemanticDownloadError) ||
              !error.retryable ||
              attempt >= 1 ||
              options.signal?.aborted
            )
              throw error;
            received = beforeFile;
            options.onProgress?.(
              received,
              totalSize(manifest),
              `${file.relativePath} — 网络中断，重试 1/1`,
            );
          }
        }
        const size = await this.fileSystem.fileSize(path);
        if (size !== file.size)
          throw new Error(`Downloaded artifact size mismatch: ${file.relativePath}`);
        const digest = (await this.fileSystem.sha256(path)).toLocaleLowerCase();
        if (digest !== file.sha256.toLocaleLowerCase())
          throw new Error(
            `Downloaded artifact checksum mismatch: ${file.relativePath}`,
          );
      }
      await this.fileSystem.writeText(
        this.fileSystem.join(staging, MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await this.fileSystem.mkdir(this.fileSystem.parent(destination));
      await this.fileSystem.move(staging, destination);
      return await this.requireVerified(manifest);
    } catch (error) {
      await this.fileSystem.removeTree(staging).catch(() => undefined);
      throw error;
    }
  }

  async delete(manifest: SemanticArtifactManifest, confirmed: boolean): Promise<void> {
    if (!confirmed)
      throw new Error("Semantic artifact deletion requires user confirmation");
    const location = this.getLocation(manifest);
    if (!(await this.fileSystem.exists(location))) return;
    await this.verifyManagedRoot();
    await this.verifyInstalledManifest(location, manifest);
    await this.fileSystem.removeTree(location);
  }

  async deleteAllManagedData(confirmed: boolean): Promise<void> {
    if (!confirmed)
      throw new Error("Deleting all managed semantic artifacts requires confirmation");
    if (!(await this.fileSystem.exists(this.rootDirectory))) return;
    await this.verifyManagedRoot();
    await this.fileSystem.removeTree(this.rootDirectory);
  }

  private async requireVerified(
    manifest: SemanticArtifactManifest,
  ): Promise<SemanticArtifactStatus> {
    const status = await this.inspect(manifest);
    if (!status.verified)
      throw new Error(status.failure || "Semantic artifact verification failed");
    return status;
  }

  private async ensureManagedRoot(): Promise<void> {
    await this.fileSystem.mkdir(this.rootDirectory);
    const markerPath = this.fileSystem.join(this.rootDirectory, ROOT_MARKER);
    if (await this.fileSystem.exists(markerPath)) {
      await this.verifyManagedRoot();
      return;
    }
    await this.fileSystem.writeText(
      markerPath,
      `${JSON.stringify({ installationID: this.installationID, formatVersion: 1 })}\n`,
    );
  }

  private async verifyManagedRoot(): Promise<void> {
    const markerPath = this.fileSystem.join(this.rootDirectory, ROOT_MARKER);
    if (!(await this.fileSystem.exists(markerPath)))
      throw new Error("Semantic artifact root marker is missing");
    const marker = JSON.parse(await this.fileSystem.readText(markerPath)) as {
      installationID?: string;
      formatVersion?: number;
    };
    if (marker.installationID !== this.installationID || marker.formatVersion !== 1)
      throw new Error("Semantic artifact root belongs to another installation");
  }

  private async verifyInstalledManifest(
    location: string,
    expected: SemanticArtifactManifest,
  ): Promise<void> {
    const manifestPath = this.fileSystem.join(location, MANIFEST_FILE);
    if (!(await this.fileSystem.exists(manifestPath)))
      throw new Error("Installed semantic artifact manifest is missing");
    const actual = JSON.parse(
      await this.fileSystem.readText(manifestPath),
    ) as SemanticArtifactManifest;
    if (artifactIdentity(actual) !== artifactIdentity(expected))
      throw new Error("Installed semantic artifact manifest does not match");
  }
}

// Transport locations can change; identity, file paths, hashes and sizes cannot.
export function artifactIdentity(manifest: SemanticArtifactManifest): string {
  return JSON.stringify({
    ...manifest,
    files: manifest.files.map(({ url: _url, ...file }) => file),
  });
}

export class SemanticDownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SemanticDownloadError";
  }
}

export class HTTPSemanticArtifactSource implements SemanticArtifactSource {
  constructor(private readonly idleTimeoutMs = 60_000) {}
  async *read(
    file: SemanticArtifactFile,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const url = new URL(file.url);
    if (url.protocol !== "https:")
      throw new Error("Semantic artifacts must be downloaded over HTTPS");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.idleTimeoutMs);
    };
    arm();
    let received = 0;
    let stage = "连接下载服务器";
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: "omit",
      });
      if (response.url && new URL(response.url).protocol !== "https:")
        throw new Error("Semantic download redirected away from HTTPS");
      if (!response.ok || !response.body)
        throw new SemanticDownloadError(
          `模型下载失败：${file.relativePath}；服务器 ${url.hostname}；HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      stage = "读取模型文件";
      const reader = response.body.getReader() as any;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) return;
          arm();
          if (result.value?.byteLength) {
            received += result.value.byteLength;
            yield result.value;
          }
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    } catch (error) {
      if (signal?.aborted) throw new Error("模型下载已取消");
      if (error instanceof SemanticDownloadError) throw error;
      if (
        timedOut ||
        error instanceof TypeError ||
        /NetworkError|network/i.test(String(error))
      )
        throw new SemanticDownloadError(
          `${stage}失败：${file.relativePath}；服务器 ${url.hostname}；已接收 ${received} 字节；${timedOut ? "网络等待超时" : "网络连接失败"}。请检查 Zotero 的代理、网络或服务器可达性。`,
          true,
        );
      throw error;
    } finally {
      clearTimeout(timer!);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function validateManifest(manifest: SemanticArtifactManifest): void {
  if (manifest.formatVersion !== 1)
    throw new Error("Unsupported semantic artifact manifest version");
  if (!manifest.packageID.trim() || !manifest.version.trim())
    throw new Error("Semantic artifact package ID and version are required");
  if (manifest.platform !== "win-x64")
    throw new Error("Semantic artifact platform is unsupported");
  if (!manifest.files.length) throw new Error("Semantic artifact manifest is empty");
  const paths = new Set<string>();
  for (const file of manifest.files) {
    validateRelativePath(file.relativePath);
    if (paths.has(file.relativePath))
      throw new Error(`Duplicate semantic artifact path: ${file.relativePath}`);
    paths.add(file.relativePath);
    if (!Number.isInteger(file.size) || file.size < 0)
      throw new Error(`Invalid semantic artifact size: ${file.relativePath}`);
    if (!/^[a-f0-9]{64}$/i.test(file.sha256))
      throw new Error(`Invalid semantic artifact SHA-256: ${file.relativePath}`);
    const url = new URL(file.url);
    if (url.protocol !== "https:")
      throw new Error(`Semantic artifact URL must use HTTPS: ${file.relativePath}`);
  }
}

function validateRelativePath(value: string): void {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Unsafe semantic artifact path: ${value}`);
}

function artifactPath(
  fileSystem: SemanticArtifactFileSystem,
  root: string,
  relativePath: string,
): string {
  validateRelativePath(relativePath);
  return fileSystem.join(root, ...relativePath.replace(/\\/g, "/").split("/"));
}

function safeComponent(value: string): string {
  const safe = encodeURIComponent(value.trim());
  if (!safe || safe === "." || safe === "..")
    throw new Error("Semantic artifact path component is invalid");
  return safe;
}

function totalSize(manifest: SemanticArtifactManifest): number {
  return manifest.files.reduce((sum, file) => sum + file.size, 0);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}
