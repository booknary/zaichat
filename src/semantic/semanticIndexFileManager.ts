import { SemanticArtifactFileSystem } from "./semanticArtifactManager";

const INDEX_ROOT_MARKER = ".zaichat-semantic-index-root";
const INDEX_FILES = ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"];
const AUXILIARY_FILES = ["abstract-enrichment.json"];

export interface SemanticIndexFileStatus {
  installed: boolean;
  verified: boolean;
  location: string;
  databasePath: string;
  diskUsage: number;
  failure?: string;
}

export class SemanticIndexFileManager {
  constructor(
    private readonly fileSystem: SemanticArtifactFileSystem,
    private readonly rootDirectory: string,
    private readonly installationID: string,
  ) {
    if (!rootDirectory.trim()) throw new Error("Semantic index root is required");
    if (!installationID.trim())
      throw new Error("Semantic index installation ID is required");
  }

  getDatabasePath(): string {
    return this.fileSystem.join(this.rootDirectory, INDEX_FILES[0]);
  }

  async prepare(): Promise<string> {
    if (await this.fileSystem.exists(this.rootDirectory)) {
      await this.verifyManagedRoot();
      return this.getDatabasePath();
    }
    await this.fileSystem.mkdir(this.rootDirectory);
    await this.fileSystem.writeText(
      this.markerPath(),
      `${JSON.stringify({ installationID: this.installationID, formatVersion: 1 })}\n`,
    );
    return this.getDatabasePath();
  }

  async inspect(): Promise<SemanticIndexFileStatus> {
    const databasePath = this.getDatabasePath();
    if (!(await this.fileSystem.exists(this.rootDirectory)))
      return {
        installed: false,
        verified: false,
        location: this.rootDirectory,
        databasePath,
        diskUsage: 0,
      };
    try {
      await this.verifyManagedRoot();
      let diskUsage = 0;
      for (const name of [...INDEX_FILES, ...AUXILIARY_FILES]) {
        const path = this.fileSystem.join(this.rootDirectory, name);
        if (await this.fileSystem.exists(path))
          diskUsage += await this.fileSystem.fileSize(path);
      }
      return {
        installed: await this.fileSystem.exists(databasePath),
        verified: true,
        location: this.rootDirectory,
        databasePath,
        diskUsage,
      };
    } catch (error) {
      return {
        installed: await this.fileSystem.exists(databasePath),
        verified: false,
        location: this.rootDirectory,
        databasePath,
        diskUsage: 0,
        failure: safeError(error),
      };
    }
  }

  async clear(confirmed: boolean): Promise<void> {
    if (!confirmed)
      throw new Error("Clearing the semantic index requires confirmation");
    if (await this.fileSystem.exists(this.rootDirectory)) {
      await this.verifyManagedRoot();
      await this.fileSystem.removeTree(this.rootDirectory);
    }
    await this.prepare();
  }

  async deleteAll(confirmed: boolean): Promise<void> {
    if (!confirmed)
      throw new Error("Deleting all semantic index data requires confirmation");
    if (!(await this.fileSystem.exists(this.rootDirectory))) return;
    await this.verifyManagedRoot();
    await this.fileSystem.removeTree(this.rootDirectory);
  }

  private async verifyManagedRoot(): Promise<void> {
    if (!(await this.fileSystem.exists(this.markerPath())))
      throw new Error("Semantic index root marker is missing");
    const marker = JSON.parse(await this.fileSystem.readText(this.markerPath())) as {
      installationID?: string;
      formatVersion?: number;
    };
    if (marker.installationID !== this.installationID || marker.formatVersion !== 1)
      throw new Error("Semantic index root belongs to another installation");
  }

  private markerPath(): string {
    return this.fileSystem.join(this.rootDirectory, INDEX_ROOT_MARKER);
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}
