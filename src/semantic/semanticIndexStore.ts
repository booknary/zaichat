import { createID, nowISO } from "../utils/ids";
import {
  SEMANTIC_INDEX_SCHEMA_VERSION,
  PaperSemanticRef,
  SemanticDatabase,
  SemanticGeneration,
  SemanticGenerationState,
  SemanticIndexJob,
  SemanticIndexJobItem,
  SemanticIndexJobState,
  SemanticModelFingerprint,
  SemanticNamespace,
  SemanticSearchHit,
  SemanticVectorRecord,
  StoredSemanticRecord,
} from "./types";
import { decodeVector, encodeVector, normalizeVector } from "./vector";

interface GenerationRow extends Record<string, unknown> {
  generationID: string;
  namespace: string;
  state: string;
  modelID: string;
  modelVersion: string;
  modelFingerprint: string;
  modelSHA256: string;
  tokenizerSHA256: string;
  dimensions: number;
  pooling: string;
  normalization: string;
  indexSchemaVersion: number;
  createdAt: string;
  activatedAt: string | null;
  recordCount: number;
}

interface RecordRow extends Record<string, unknown> {
  generationID: string;
  namespace: string;
  recordID: string;
  recordType: string;
  sourceType: string;
  sourceField: string;
  libraryID: number;
  itemKey: string;
  sourceHash: string;
  dimensions: number;
  vector?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface VectorCache {
  generationID: string;
  dimensions: number;
  records: StoredSemanticRecord[];
  matrix: Float32Array;
}

interface IndexJobRow extends Record<string, unknown> {
  job_id: string;
  namespace: string;
  generation_id: string;
  model_fingerprint: string;
  state: string;
  total_items: number;
  completed_items: number;
  created_at: string;
  updated_at: string;
  failure_code: string | null;
}

interface IndexJobItemRow extends Record<string, unknown> {
  position: number;
  library_id: number;
  item_key: string;
}

export class SemanticIndexStore {
  private initialized = false;
  private closed = false;
  private readonly caches = new Map<SemanticNamespace, VectorCache>();

  constructor(private readonly database: SemanticDatabase) {}

  async initialize(): Promise<void> {
    this.ensureOpen();
    if (this.initialized) return;
    await this.database.execute("PRAGMA foreign_keys = ON");
    await this.database.execute("PRAGMA journal_mode = WAL");
    await this.database.execute("PRAGMA synchronous = NORMAL");
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS semantic_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS semantic_generations (
        generation_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('building', 'active', 'retired', 'failed')),
        model_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        model_fingerprint TEXT NOT NULL,
        model_sha256 TEXT NOT NULL,
        tokenizer_sha256 TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions > 0),
        pooling TEXT NOT NULL,
        normalization TEXT NOT NULL,
        index_schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        record_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    await this.database.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS semantic_one_active_generation
      ON semantic_generations(namespace)
      WHERE state = 'active'
    `);
    await this.database.execute(`
      CREATE INDEX IF NOT EXISTS semantic_generation_state
      ON semantic_generations(namespace, state, created_at)
    `);
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS semantic_records (
        generation_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        record_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_field TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions > 0),
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(generation_id, record_id),
        FOREIGN KEY(generation_id) REFERENCES semantic_generations(generation_id)
          ON DELETE CASCADE
      )
    `);
    await this.database.execute(`
      CREATE INDEX IF NOT EXISTS semantic_records_source
      ON semantic_records(generation_id, library_id, item_key, source_field)
    `);
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS semantic_index_jobs (
        job_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        model_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'running', 'paused', 'cancelled', 'completed', 'failed'
        )),
        total_items INTEGER NOT NULL CHECK(total_items >= 0),
        completed_items INTEGER NOT NULL DEFAULT 0 CHECK(completed_items >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        failure_code TEXT,
        FOREIGN KEY(generation_id) REFERENCES semantic_generations(generation_id)
          ON DELETE CASCADE
      )
    `);
    await this.database.execute(`
      CREATE INDEX IF NOT EXISTS semantic_index_jobs_recovery
      ON semantic_index_jobs(namespace, model_fingerprint, state, updated_at)
    `);
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS semantic_index_job_items (
        job_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'completed')),
        PRIMARY KEY(job_id, position),
        UNIQUE(job_id, library_id, item_key),
        FOREIGN KEY(job_id) REFERENCES semantic_index_jobs(job_id)
          ON DELETE CASCADE
      )
    `);
    await this.database.execute(`
      CREATE INDEX IF NOT EXISTS semantic_index_job_pending
      ON semantic_index_job_items(job_id, state, position)
    `);
    const metadata = await this.database.query<{ value: string }>(
      "SELECT value FROM semantic_metadata WHERE key = ?",
      ["index_schema_version"],
    );
    if (!metadata.length) {
      await this.database.execute(
        "INSERT INTO semantic_metadata(key, value) VALUES (?, ?)",
        ["index_schema_version", String(SEMANTIC_INDEX_SCHEMA_VERSION)],
      );
    } else if (Number(metadata[0].value) !== SEMANTIC_INDEX_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported semantic index schema ${metadata[0].value}; expected ${SEMANTIC_INDEX_SCHEMA_VERSION}`,
      );
    }
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.caches.clear();
    this.closed = true;
    await this.database.close();
  }

  async createGeneration(
    namespace: SemanticNamespace,
    model: SemanticModelFingerprint,
  ): Promise<SemanticGeneration> {
    await this.ensureInitialized();
    validateNamespace(namespace);
    validateModel(model);
    const generationID = createID("semgen");
    const createdAt = nowISO();
    await this.database.execute(
      `INSERT INTO semantic_generations(
        generation_id, namespace, state, model_id, model_version,
        model_fingerprint, model_sha256, tokenizer_sha256, dimensions,
        pooling, normalization, index_schema_version, created_at, record_count
      ) VALUES (?, ?, 'building', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        generationID,
        namespace,
        model.modelID,
        model.version,
        model.fingerprint,
        model.modelSHA256,
        model.tokenizerSHA256,
        model.dimensions,
        model.pooling,
        model.normalization,
        SEMANTIC_INDEX_SCHEMA_VERSION,
        createdAt,
      ],
    );
    return {
      generationID,
      namespace,
      state: "building",
      model,
      indexSchemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
      createdAt,
      recordCount: 0,
    };
  }

  async getGeneration(generationID: string): Promise<SemanticGeneration | null> {
    await this.ensureInitialized();
    const rows = await this.database.query<GenerationRow>(
      `${GENERATION_SELECT} WHERE generation_id = ?`,
      [generationID],
    );
    if (!rows.length) return null;
    const activatedAt = await this.readActivationTime(generationID);
    return generationFromRow(rows[0], activatedAt);
  }

  async getActiveGeneration(
    namespace: SemanticNamespace,
  ): Promise<SemanticGeneration | null> {
    await this.ensureInitialized();
    const rows = await this.database.query<GenerationRow>(
      `${GENERATION_SELECT} WHERE namespace = ? AND state = 'active'`,
      [namespace],
    );
    if (!rows.length) return null;
    const activatedAt = await this.readActivationTime(
      String(rows[0].generationID ?? rows[0].generation_id),
    );
    return generationFromRow(rows[0], activatedAt);
  }

  async insertRecords(
    generationID: string,
    records: SemanticVectorRecord[],
  ): Promise<void> {
    if (!records.length) return;
    const generation = await this.requireWritableGeneration(generationID);
    const timestamp = nowISO();
    await this.database.transaction(async () => {
      for (const record of records) {
        const vector = prepareRecordVector(record, generation);
        await this.database.execute(
          `INSERT INTO semantic_records(
            generation_id, namespace, record_id, record_type, source_type,
            source_field, library_id, item_key, source_hash, dimensions,
            vector, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            generationID,
            record.namespace,
            record.recordID,
            record.recordType,
            record.sourceType,
            record.sourceField,
            record.libraryID,
            record.itemKey,
            record.sourceHash,
            vector.length,
            encodeVector(vector),
            timestamp,
            timestamp,
          ],
        );
      }
      await this.refreshRecordCount(generationID);
    });
    this.invalidate(generation.namespace);
  }

  async updateRecords(
    generationID: string,
    records: SemanticVectorRecord[],
  ): Promise<void> {
    if (!records.length) return;
    const generation = await this.requireWritableGeneration(generationID);
    const timestamp = nowISO();
    await this.database.transaction(async () => {
      for (const record of records) {
        const vector = prepareRecordVector(record, generation);
        await this.database.execute(
          `UPDATE semantic_records SET
            namespace = ?, record_type = ?, source_type = ?, source_field = ?,
            library_id = ?, item_key = ?, source_hash = ?, dimensions = ?,
            vector = ?, updated_at = ?
          WHERE generation_id = ? AND record_id = ?`,
          [
            record.namespace,
            record.recordType,
            record.sourceType,
            record.sourceField,
            record.libraryID,
            record.itemKey,
            record.sourceHash,
            vector.length,
            encodeVector(vector),
            timestamp,
            generationID,
            record.recordID,
          ],
        );
        if ((await this.lastChangeCount()) !== 1)
          throw new Error(`Semantic record ${record.recordID} does not exist`);
      }
    });
    this.invalidate(generation.namespace);
  }

  async deleteRecords(generationID: string, recordIDs: string[]): Promise<number> {
    if (!recordIDs.length) return 0;
    const generation = await this.requireWritableGeneration(generationID);
    let deleted = 0;
    await this.database.transaction(async () => {
      for (const recordID of [...new Set(recordIDs)]) {
        await this.database.execute(
          "DELETE FROM semantic_records WHERE generation_id = ? AND record_id = ?",
          [generationID, recordID],
        );
        deleted += await this.lastChangeCount();
      }
      await this.refreshRecordCount(generationID);
    });
    this.invalidate(generation.namespace);
    return deleted;
  }

  async deleteSourceRecords(
    generationID: string,
    libraryID: number,
    itemKey: string,
  ): Promise<number> {
    const generation = await this.requireWritableGeneration(generationID);
    let deleted = 0;
    await this.database.transaction(async () => {
      await this.database.execute(
        `DELETE FROM semantic_records
         WHERE generation_id = ? AND library_id = ? AND item_key = ?`,
        [generationID, libraryID, itemKey],
      );
      deleted = await this.lastChangeCount();
      await this.refreshRecordCount(generationID);
    });
    this.invalidate(generation.namespace);
    return deleted;
  }

  async replaceSourceRecords(
    generationID: string,
    source: PaperSemanticRef,
    records: SemanticVectorRecord[],
  ): Promise<void> {
    const generation = await this.requireWritableGeneration(generationID);
    const timestamp = nowISO();
    const prepared = records.map((record) => ({
      record,
      vector: prepareRecordVector(record, generation),
    }));
    if (
      prepared.some(
        ({ record }) =>
          record.libraryID !== source.libraryID || record.itemKey !== source.itemKey,
      )
    )
      throw new Error("Replacement records must belong to the requested paper");
    await this.database.transaction(async () => {
      await this.database.execute(
        `DELETE FROM semantic_records
         WHERE generation_id = ? AND library_id = ? AND item_key = ?`,
        [generationID, source.libraryID, source.itemKey],
      );
      for (const { record, vector } of prepared) {
        await this.insertRecord(generationID, record, vector, timestamp);
      }
      await this.refreshRecordCount(generationID);
    });
    this.invalidate(generation.namespace);
  }

  async listIndexedSources(generationID: string): Promise<PaperSemanticRef[]> {
    await this.ensureInitialized();
    const rows = await this.database.query<
      Record<string, unknown> & { library_id: number; item_key: string }
    >(
      `SELECT library_id, item_key FROM semantic_records
       WHERE generation_id = ? GROUP BY library_id, item_key
       ORDER BY library_id, item_key`,
      [generationID],
    );
    return rows.map((row) => ({
      libraryID: Number(row.library_id),
      itemKey: String(row.item_key),
    }));
  }

  async createIndexJob(
    namespace: SemanticNamespace,
    generationID: string,
    modelFingerprint: string,
    refs: PaperSemanticRef[],
  ): Promise<SemanticIndexJob> {
    const generation = await this.requireGenerationState(generationID, "building");
    if (
      generation.namespace !== namespace ||
      generation.model.fingerprint !== modelFingerprint
    )
      throw new Error("Semantic index job does not match its generation");
    const unique = deduplicateRefs(refs);
    const jobID = createID("semjob");
    const timestamp = nowISO();
    await this.database.transaction(async () => {
      await this.database.execute(
        `INSERT INTO semantic_index_jobs(
          job_id, namespace, generation_id, model_fingerprint, state,
          total_items, completed_items, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'paused', ?, 0, ?, ?)`,
        [
          jobID,
          namespace,
          generationID,
          modelFingerprint,
          unique.length,
          timestamp,
          timestamp,
        ],
      );
      for (let offset = 0; offset < unique.length; offset += 200) {
        const batch = unique.slice(offset, offset + 200);
        const placeholders = batch.map(() => "(?, ?, ?, ?, 'pending')").join(",");
        const params = batch.flatMap((ref, index) => [
          jobID,
          offset + index,
          ref.libraryID,
          ref.itemKey,
        ]);
        await this.database.execute(
          `INSERT INTO semantic_index_job_items(
            job_id, position, library_id, item_key, state
          ) VALUES ${placeholders}`,
          params,
        );
      }
    });
    const job = await this.getIndexJob(jobID);
    if (!job) throw new Error("Created semantic index job vanished");
    return job;
  }

  async getIndexJob(jobID: string): Promise<SemanticIndexJob | null> {
    await this.ensureInitialized();
    const rows = await this.database.query<IndexJobRow>(
      "SELECT * FROM semantic_index_jobs WHERE job_id = ?",
      [jobID],
    );
    return rows.length ? indexJobFromRow(rows[0]) : null;
  }

  async getRecoverableIndexJob(
    namespace: SemanticNamespace,
    modelFingerprint: string,
  ): Promise<SemanticIndexJob | null> {
    await this.ensureInitialized();
    const rows = await this.database.query<IndexJobRow>(
      `SELECT * FROM semantic_index_jobs
       WHERE namespace = ? AND model_fingerprint = ?
         AND state IN ('running', 'paused')
       ORDER BY updated_at DESC LIMIT 1`,
      [namespace, modelFingerprint],
    );
    return rows.length ? indexJobFromRow(rows[0]) : null;
  }

  async listPendingIndexJobItems(
    jobID: string,
    limit: number,
  ): Promise<SemanticIndexJobItem[]> {
    await this.ensureInitialized();
    const bounded = Math.min(200, Math.max(1, Math.trunc(limit)));
    const rows = await this.database.query<IndexJobItemRow>(
      `SELECT position, library_id, item_key FROM semantic_index_job_items
       WHERE job_id = ? AND state = 'pending'
       ORDER BY position LIMIT ${bounded}`,
      [jobID],
    );
    return rows.map((row) => ({
      position: Number(row.position),
      libraryID: Number(row.library_id),
      itemKey: String(row.item_key),
    }));
  }

  async markIndexJobItemsCompleted(
    jobID: string,
    positions: number[],
  ): Promise<SemanticIndexJob> {
    const unique = [...new Set(positions.map((value) => Math.trunc(value)))];
    if (!unique.length) {
      const unchanged = await this.getIndexJob(jobID);
      if (!unchanged) throw new Error("Semantic index job does not exist");
      return unchanged;
    }
    const timestamp = nowISO();
    await this.database.transaction(async () => {
      const placeholders = unique.map(() => "?").join(",");
      await this.database.execute(
        `UPDATE semantic_index_job_items SET state = 'completed'
         WHERE job_id = ? AND state = 'pending' AND position IN (${placeholders})`,
        [jobID, ...unique],
      );
      await this.database.execute(
        `UPDATE semantic_index_jobs SET
          completed_items = (
            SELECT COUNT(*) FROM semantic_index_job_items
            WHERE job_id = ? AND state = 'completed'
          ), updated_at = ?
         WHERE job_id = ?`,
        [jobID, timestamp, jobID],
      );
    });
    const job = await this.getIndexJob(jobID);
    if (!job) throw new Error("Semantic index job does not exist");
    return job;
  }

  async setIndexJobState(
    jobID: string,
    state: SemanticIndexJobState,
    failureCode?: string,
  ): Promise<SemanticIndexJob> {
    await this.ensureInitialized();
    await this.database.execute(
      `UPDATE semantic_index_jobs
       SET state = ?, failure_code = ?, updated_at = ? WHERE job_id = ?`,
      [state, failureCode || null, nowISO(), jobID],
    );
    if ((await this.lastChangeCount()) !== 1)
      throw new Error("Semantic index job does not exist");
    const job = await this.getIndexJob(jobID);
    if (!job) throw new Error("Semantic index job does not exist");
    return job;
  }

  async listSourceRecords(
    generationID: string,
    libraryID: number,
    itemKey: string,
  ): Promise<StoredSemanticRecord[]> {
    await this.ensureInitialized();
    const rows = await this.database.query<RecordRow>(
      `SELECT * FROM semantic_records
       WHERE generation_id = ? AND library_id = ? AND item_key = ?
       ORDER BY source_field`,
      [generationID, libraryID, itemKey],
    );
    return rows.map(recordFromRow);
  }

  async findReusableVector(
    generationID: string,
    sourceHash: string,
    sourceField: string,
  ): Promise<Float32Array | null> {
    const generation = await this.requireWritableGeneration(generationID);
    const rows = await this.database.query<RecordRow>(
      `SELECT * FROM semantic_records
       WHERE generation_id = ? AND source_hash = ? AND source_field = ? LIMIT 1`,
      [generationID, sourceHash, sourceField],
    );
    return rows.length
      ? decodeVector(rows[0].vector, generation.model.dimensions)
      : null;
  }

  async activateGeneration(generationID: string): Promise<SemanticGeneration> {
    const generation = await this.requireGenerationState(generationID, "building");
    const activatedAt = nowISO();
    await this.database.transaction(async () => {
      await this.database.execute(
        `UPDATE semantic_generations SET state = 'retired'
         WHERE namespace = ? AND state = 'active'`,
        [generation.namespace],
      );
      await this.refreshRecordCount(generationID);
      await this.database.execute(
        `UPDATE semantic_generations
         SET state = 'active', activated_at = ?
         WHERE generation_id = ? AND state = 'building'`,
        [activatedAt, generationID],
      );
      if ((await this.lastChangeCount()) !== 1)
        throw new Error(`Semantic generation ${generationID} could not be activated`);
    });
    this.invalidate(generation.namespace);
    const active = await this.getGeneration(generationID);
    if (!active)
      throw new Error(`Activated semantic generation ${generationID} vanished`);
    return active;
  }

  async markGenerationFailed(generationID: string): Promise<void> {
    const generation = await this.getGeneration(generationID);
    if (!generation || generation.state !== "building") return;
    await this.database.execute(
      "UPDATE semantic_generations SET state = 'failed' WHERE generation_id = ?",
      [generationID],
    );
    this.invalidate(generation.namespace);
  }

  async searchCosine(
    namespace: SemanticNamespace,
    queryVector: Float32Array,
    limit = 10,
    minimumScore = -1,
  ): Promise<SemanticSearchHit[]> {
    await this.ensureInitialized();
    const active = await this.getActiveGeneration(namespace);
    if (!active) return [];
    if (queryVector.length !== active.model.dimensions)
      throw new Error(
        `Semantic query has ${queryVector.length} dimensions; expected ${active.model.dimensions}`,
      );
    const normalizedQuery = normalizeVector(queryVector);
    const cache = await this.loadCache(active);
    const requested = Math.min(1000, Math.max(1, Math.trunc(limit)));
    const best: SemanticSearchHit[] = [];
    for (let row = 0; row < cache.records.length; row += 1) {
      let score = 0;
      const offset = row * cache.dimensions;
      for (let column = 0; column < cache.dimensions; column += 1)
        score += cache.matrix[offset + column] * normalizedQuery[column];
      if (score < minimumScore) continue;
      best.push({ ...cache.records[row], score });
      best.sort(compareHits);
      if (best.length > requested) best.pop();
    }
    return best;
  }

  private async loadCache(generation: SemanticGeneration): Promise<VectorCache> {
    const cached = this.caches.get(generation.namespace);
    if (cached?.generationID === generation.generationID) return cached;
    const rows = await this.database.query<RecordRow>(
      `SELECT * FROM semantic_records
       WHERE generation_id = ?
       ORDER BY record_id`,
      [generation.generationID],
    );
    const matrix = new Float32Array(rows.length * generation.model.dimensions);
    const records: StoredSemanticRecord[] = [];
    rows.forEach((row, index) => {
      const vector = decodeVector(row.vector, generation.model.dimensions);
      matrix.set(vector, index * generation.model.dimensions);
      records.push(recordFromRow(row));
    });
    const value = {
      generationID: generation.generationID,
      dimensions: generation.model.dimensions,
      records,
      matrix,
    };
    this.caches.set(generation.namespace, value);
    return value;
  }

  private async requireWritableGeneration(
    generationID: string,
  ): Promise<SemanticGeneration> {
    await this.ensureInitialized();
    const generation = await this.getGeneration(generationID);
    if (!generation || !["building", "active"].includes(generation.state))
      throw new Error(`Semantic generation ${generationID} is not writable`);
    return generation;
  }

  private async requireGenerationState(
    generationID: string,
    state: SemanticGenerationState,
  ): Promise<SemanticGeneration> {
    await this.ensureInitialized();
    const generation = await this.getGeneration(generationID);
    if (!generation || generation.state !== state)
      throw new Error(`Semantic generation ${generationID} is not ${state}`);
    return generation;
  }

  private async refreshRecordCount(generationID: string): Promise<void> {
    await this.database.execute(
      `UPDATE semantic_generations
       SET record_count = (
         SELECT COUNT(*) FROM semantic_records WHERE generation_id = ?
       ) WHERE generation_id = ?`,
      [generationID, generationID],
    );
  }

  private async insertRecord(
    generationID: string,
    record: SemanticVectorRecord,
    vector: Float32Array,
    timestamp: string,
  ): Promise<void> {
    await this.database.execute(
      `INSERT INTO semantic_records(
        generation_id, namespace, record_id, record_type, source_type,
        source_field, library_id, item_key, source_hash, dimensions,
        vector, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generationID,
        record.namespace,
        record.recordID,
        record.recordType,
        record.sourceType,
        record.sourceField,
        record.libraryID,
        record.itemKey,
        record.sourceHash,
        vector.length,
        encodeVector(vector),
        timestamp,
        timestamp,
      ],
    );
  }

  private async lastChangeCount(): Promise<number> {
    const rows = await this.database.query<{ count: number }>(
      "SELECT changes() AS count",
    );
    return Number(rows[0]?.count || 0);
  }

  private async readActivationTime(generationID: string): Promise<string | null> {
    const rows = await this.database.query<{ activatedAt: string }>(
      `SELECT COALESCE(activated_at, '') AS activatedAt
       FROM semantic_generations WHERE generation_id = ?`,
      [generationID],
    );
    return rows[0]?.activatedAt || null;
  }

  private invalidate(namespace: SemanticNamespace): void {
    this.caches.delete(namespace);
  }

  private async ensureInitialized(): Promise<void> {
    this.ensureOpen();
    if (!this.initialized) await this.initialize();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Semantic index store is closed");
  }
}

const GENERATION_SELECT = `SELECT generation_id AS generationID, namespace AS namespace,
  state AS state, model_id AS modelID, model_version AS modelVersion,
  model_fingerprint AS modelFingerprint, model_sha256 AS modelSHA256,
  tokenizer_sha256 AS tokenizerSHA256, dimensions AS dimensions,
  pooling AS pooling, normalization AS normalization,
  index_schema_version AS indexSchemaVersion, created_at AS createdAt,
  record_count AS recordCount
FROM semantic_generations`;

function generationFromRow(
  row: GenerationRow,
  activatedAt: string | null,
): SemanticGeneration {
  return {
    generationID: String(row.generationID ?? row.generation_id),
    namespace: String(row.namespace),
    state: String(row.state) as SemanticGenerationState,
    model: {
      modelID: String(row.modelID ?? row.model_id),
      version: String(row.modelVersion ?? row.model_version),
      fingerprint: String(row.modelFingerprint ?? row.model_fingerprint),
      modelSHA256: String(row.modelSHA256 ?? row.model_sha256),
      tokenizerSHA256: String(row.tokenizerSHA256 ?? row.tokenizer_sha256),
      dimensions: Number(row.dimensions),
      pooling: String(row.pooling) as "mean",
      normalization: String(row.normalization) as "l2",
    },
    indexSchemaVersion: Number(row.indexSchemaVersion ?? row.index_schema_version),
    createdAt: String(row.createdAt ?? row.created_at),
    activatedAt: activatedAt || undefined,
    recordCount: Number(row.recordCount ?? row.record_count),
  };
}

function recordFromRow(row: RecordRow): StoredSemanticRecord {
  return {
    generationID: String(row.generation_id),
    namespace: String(row.namespace),
    recordID: String(row.record_id),
    recordType: String(row.record_type),
    sourceType: String(row.source_type),
    sourceField: String(row.source_field),
    libraryID: Number(row.library_id),
    itemKey: String(row.item_key),
    sourceHash: String(row.source_hash),
    dimensions: Number(row.dimensions),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function prepareRecordVector(
  record: SemanticVectorRecord,
  generation: SemanticGeneration,
): Float32Array {
  if (record.namespace !== generation.namespace)
    throw new Error("Semantic record namespace does not match its generation");
  if (record.vector.length !== generation.model.dimensions)
    throw new Error(
      `Semantic record ${record.recordID} has ${record.vector.length} dimensions; expected ${generation.model.dimensions}`,
    );
  if (!record.recordID || !record.itemKey || !record.sourceHash)
    throw new Error("Semantic record identity and source hash are required");
  return normalizeVector(record.vector);
}

function validateNamespace(namespace: string): void {
  if (!namespace.trim()) throw new Error("Semantic namespace is required");
}

function validateModel(model: SemanticModelFingerprint): void {
  if (!model.fingerprint || !model.modelID || !model.version)
    throw new Error("Semantic model fingerprint is incomplete");
  if (!Number.isInteger(model.dimensions) || model.dimensions <= 0)
    throw new Error("Semantic model dimensions must be a positive integer");
  if (model.pooling !== "mean" || model.normalization !== "l2")
    throw new Error("Semantic model must use mean pooling and L2 normalization");
}

function compareHits(left: SemanticSearchHit, right: SemanticSearchHit): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.recordID.localeCompare(right.recordID);
}

function indexJobFromRow(row: IndexJobRow): SemanticIndexJob {
  const failureCode = row.failure_code ? String(row.failure_code) : undefined;
  return {
    jobID: String(row.job_id),
    namespace: String(row.namespace),
    generationID: String(row.generation_id),
    modelFingerprint: String(row.model_fingerprint),
    state: String(row.state) as SemanticIndexJobState,
    totalItems: Number(row.total_items),
    completedItems: Number(row.completed_items),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(failureCode ? { failureCode } : {}),
  };
}

function deduplicateRefs(refs: PaperSemanticRef[]): PaperSemanticRef[] {
  const unique = new Map<string, PaperSemanticRef>();
  for (const ref of refs) {
    if (!Number.isInteger(ref.libraryID) || ref.libraryID <= 0 || !ref.itemKey)
      throw new Error("Semantic paper references require a library and item key");
    unique.set(`${ref.libraryID}:${ref.itemKey}`, {
      libraryID: ref.libraryID,
      itemKey: ref.itemKey,
    });
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.libraryID - right.libraryID || left.itemKey.localeCompare(right.itemKey),
  );
}
