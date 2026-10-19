import { SemanticDatabase, SemanticSqlValue } from "./types";

export class ZoteroSemanticDatabase implements SemanticDatabase {
  private closed = false;

  private constructor(private readonly connection: _ZoteroTypes.DBConnection) {}

  static async open(databasePath: string): Promise<ZoteroSemanticDatabase> {
    const parent = PathUtils.parent(databasePath);
    if (!parent) throw new Error("Semantic database path has no parent directory");
    await IOUtils.makeDirectory(parent, { ignoreExisting: true });
    return new ZoteroSemanticDatabase(new Zotero.DBConnection(databasePath));
  }

  async execute(sql: string, params: SemanticSqlValue[] = []): Promise<void> {
    this.ensureOpen();
    await this.connection.queryAsync(sql, params as any, { noCache: true });
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: SemanticSqlValue[] = [],
  ): Promise<T[]> {
    this.ensureOpen();
    return ((await this.connection.queryAsync(sql, params as any, {
      noCache: true,
    })) || []) as T[];
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    return this.connection.executeTransaction(operation);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connection.closeDatabase(true);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Zotero semantic database is closed");
  }
}

export async function openProfileSemanticDatabase(
  profileDirectory: string,
): Promise<ZoteroSemanticDatabase> {
  return ZoteroSemanticDatabase.open(
    PathUtils.join(profileDirectory, "zaichat", "semantic", "index.sqlite"),
  );
}
