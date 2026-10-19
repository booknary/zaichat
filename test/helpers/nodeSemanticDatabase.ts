import { DatabaseSync } from "node:sqlite";
import { SemanticDatabase, SemanticSqlValue } from "../../src/semantic/types";

export class NodeSemanticDatabase implements SemanticDatabase {
  private readonly database = new DatabaseSync(":memory:");
  private closed = false;

  async execute(sql: string, params: SemanticSqlValue[] = []): Promise<void> {
    this.ensureOpen();
    if (!params.length) {
      this.database.exec(sql);
      return;
    }
    this.database.prepare(sql).run(...(params as any[]));
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: SemanticSqlValue[] = [],
  ): Promise<T[]> {
    this.ensureOpen();
    return this.database.prepare(sql).all(...(params as any[])) as T[];
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = await operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Node semantic database is closed");
  }
}
