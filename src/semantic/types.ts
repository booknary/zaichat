export const PAPER_NAMESPACE = "paper" as const;
export const SEMANTIC_INDEX_SCHEMA_VERSION = 1;

export type SemanticNamespace = string;
export type PaperSourceField = "title" | "abstract" | "tags";
export type SemanticGenerationState = "building" | "active" | "retired" | "failed";
export type SemanticIndexJobState =
  | "running"
  | "paused"
  | "cancelled"
  | "completed"
  | "failed";

export interface SemanticModelFingerprintInput {
  modelID: string;
  version: string;
  dimensions: number;
  modelSHA256: string;
  tokenizerSHA256: string;
  pooling: "mean";
  normalization: "l2";
}

export interface SemanticModelFingerprint extends SemanticModelFingerprintInput {
  fingerprint: string;
}

export interface PaperSemanticSource {
  libraryID: number;
  itemKey: string;
  title: string;
  abstract: string;
  tags: string[];
  doi?: string;
  abstractSource?: "zotero" | "openalex";
}

export interface PaperSemanticRef {
  libraryID: number;
  itemKey: string;
}

export interface PreparedSemanticRecord {
  namespace: typeof PAPER_NAMESPACE;
  recordID: string;
  recordType: "paper-metadata";
  sourceType: "zotero-item" | "openalex-work";
  sourceField: PaperSourceField;
  libraryID: number;
  itemKey: string;
  sourceHash: string;
  embeddingText: string;
}

export interface SemanticVectorRecord {
  namespace: SemanticNamespace;
  recordID: string;
  recordType: string;
  sourceType: string;
  sourceField: string;
  libraryID: number;
  itemKey: string;
  sourceHash: string;
  vector: Float32Array;
}

export interface StoredSemanticRecord extends Omit<SemanticVectorRecord, "vector"> {
  generationID: string;
  dimensions: number;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticGeneration {
  generationID: string;
  namespace: SemanticNamespace;
  state: SemanticGenerationState;
  model: SemanticModelFingerprint;
  indexSchemaVersion: number;
  createdAt: string;
  activatedAt?: string;
  recordCount: number;
}

export interface SemanticSearchHit extends StoredSemanticRecord {
  score: number;
}

export interface PaperSemanticSearchResult {
  libraryID: number;
  itemKey: string;
  score: number;
  sourceFields: PaperSourceField[];
}

export interface SemanticEmbeddingProvider {
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface PaperSemanticSourceProvider {
  listPapers(): Promise<PaperSemanticSource[]>;
  listPaperRefs(): Promise<PaperSemanticRef[]>;
  getPaper(libraryID: number, itemKey: string): Promise<PaperSemanticSource | null>;
  getPaperRefByItemID(itemID: number): Promise<PaperSemanticRef | null>;
  prepareForIndexing?(): Promise<void>;
}

export interface SemanticIndexJob {
  jobID: string;
  namespace: SemanticNamespace;
  generationID: string;
  modelFingerprint: string;
  state: SemanticIndexJobState;
  totalItems: number;
  completedItems: number;
  createdAt: string;
  updatedAt: string;
  failureCode?: string;
}

export interface SemanticIndexJobItem extends PaperSemanticRef {
  position: number;
}

export type PaperIndexProgressState =
  | "idle"
  | "running"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export interface PaperIndexProgress {
  state: PaperIndexProgressState;
  jobID?: string;
  generationID?: string;
  totalItems: number;
  completedItems: number;
  vectorCount: number;
  recovered: boolean;
}

export type SemanticSqlValue = string | number | null | Uint8Array;

export interface SemanticDatabase {
  execute(sql: string, params?: SemanticSqlValue[]): Promise<void>;
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: SemanticSqlValue[],
  ): Promise<T[]>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
