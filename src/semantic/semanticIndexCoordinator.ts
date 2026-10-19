import { SemanticIndexStore } from "./semanticIndexStore";
import { SemanticRecordBuilder } from "./semanticRecordBuilder";
import {
  PAPER_NAMESPACE,
  PaperSemanticSource,
  PaperSemanticSourceProvider,
  PreparedSemanticRecord,
  SemanticEmbeddingProvider,
  SemanticGeneration,
  SemanticModelFingerprint,
  SemanticVectorRecord,
} from "./types";

export interface PaperIndexUpdateResult {
  inserted: number;
  updated: number;
  deleted: number;
  skipped: number;
}

export class SemanticIndexCoordinator {
  constructor(
    private readonly store: SemanticIndexStore,
    private readonly builder: SemanticRecordBuilder,
    private readonly embeddingProvider: SemanticEmbeddingProvider,
    private readonly model: SemanticModelFingerprint,
    private readonly paperSourceProvider?: PaperSemanticSourceProvider,
  ) {}

  async rebuildPaperGeneration(
    sources?: Iterable<PaperSemanticSource> | AsyncIterable<PaperSemanticSource>,
    batchSize = 32,
  ): Promise<SemanticGeneration> {
    if (!Number.isInteger(batchSize) || batchSize <= 0)
      throw new Error("Semantic rebuild batch size must be a positive integer");
    const source = sources || (await this.requireSourceProvider().listPapers());
    const generation = await this.store.createGeneration(PAPER_NAMESPACE, this.model);
    try {
      let batch: PreparedSemanticRecord[] = [];
      for await (const paper of toAsyncIterable(source)) {
        batch.push(...(await this.builder.buildPaper(paper)));
        if (batch.length >= batchSize) {
          await this.insertPrepared(generation.generationID, batch);
          batch = [];
        }
      }
      await this.insertPrepared(generation.generationID, batch);
      return await this.store.activateGeneration(generation.generationID);
    } catch (error) {
      await this.store.markGenerationFailed(generation.generationID);
      throw error;
    }
  }

  async indexPaper(source: PaperSemanticSource): Promise<PaperIndexUpdateResult> {
    const active = await this.requireCompatibleActiveGeneration();
    const prepared = await this.builder.buildPaper(source);
    const existing = await this.store.listSourceRecords(
      active.generationID,
      source.libraryID,
      source.itemKey,
    );
    const existingByID = new Map(existing.map((record) => [record.recordID, record]));
    const inserts: PreparedSemanticRecord[] = [];
    const updates: PreparedSemanticRecord[] = [];
    let skipped = 0;
    for (const record of prepared) {
      const previous = existingByID.get(record.recordID);
      existingByID.delete(record.recordID);
      if (!previous) inserts.push(record);
      else if (previous.sourceHash !== record.sourceHash) updates.push(record);
      else skipped += 1;
    }
    const changed = [...inserts, ...updates];
    const vectors = await this.embedPrepared(changed, active.generationID);
    const insertVectors = vectors.slice(0, inserts.length);
    const updateVectors = vectors.slice(inserts.length);
    await this.store.insertRecords(active.generationID, insertVectors);
    await this.store.updateRecords(active.generationID, updateVectors);
    const deleted = await this.store.deleteRecords(active.generationID, [
      ...existingByID.keys(),
    ]);
    return {
      inserted: insertVectors.length,
      updated: updateVectors.length,
      deleted,
      skipped,
    };
  }

  async replacePaperInGeneration(
    generationID: string,
    source: PaperSemanticSource,
  ): Promise<number> {
    const prepared = await this.builder.buildPaper(source);
    const vectors = await this.embedPrepared(prepared);
    await this.store.replaceSourceRecords(
      generationID,
      { libraryID: source.libraryID, itemKey: source.itemKey },
      vectors,
    );
    return vectors.length;
  }

  async deletePaperFromGeneration(
    generationID: string,
    libraryID: number,
    itemKey: string,
  ): Promise<void> {
    await this.store.replaceSourceRecords(generationID, { libraryID, itemKey }, []);
  }

  async indexPaperByRef(
    libraryID: number,
    itemKey: string,
  ): Promise<PaperIndexUpdateResult> {
    const source = await this.requireSourceProvider().getPaper(libraryID, itemKey);
    if (!source) {
      const deleted = await this.deletePaper(libraryID, itemKey);
      return { inserted: 0, updated: 0, deleted, skipped: 0 };
    }
    return this.indexPaper(source);
  }

  async deletePaper(libraryID: number, itemKey: string): Promise<number> {
    const active = await this.requireCompatibleActiveGeneration();
    return this.store.deleteSourceRecords(active.generationID, libraryID, itemKey);
  }

  private async insertPrepared(
    generationID: string,
    prepared: PreparedSemanticRecord[],
  ): Promise<void> {
    if (!prepared.length) return;
    await this.store.insertRecords(generationID, await this.embedPrepared(prepared));
  }

  private async embedPrepared(
    prepared: PreparedSemanticRecord[],
    reuseGenerationID?: string,
  ): Promise<SemanticVectorRecord[]> {
    if (!prepared.length) return [];
    if (reuseGenerationID) {
      const cached = await Promise.all(
        prepared.map((record) =>
          this.store.findReusableVector(
            reuseGenerationID,
            record.sourceHash,
            record.sourceField,
          ),
        ),
      );
      const missing = prepared.filter((_, index) => !cached[index]);
      const generated = await this.embedPrepared(missing);
      let next = 0;
      return prepared.map(({ embeddingText: _embeddingText, ...record }, index) => ({
        ...record,
        vector: cached[index] || generated[next++].vector,
      }));
    }
    const vectors = await this.embeddingProvider.embedDocuments(
      prepared.map((record) => record.embeddingText),
    );
    if (vectors.length !== prepared.length)
      throw new Error(
        `Embedding provider returned ${vectors.length} vectors for ${prepared.length} records`,
      );
    return prepared.map(({ embeddingText: _embeddingText, ...record }, index) => ({
      ...record,
      vector: vectors[index],
    }));
  }

  private async requireCompatibleActiveGeneration(): Promise<SemanticGeneration> {
    const active = await this.store.getActiveGeneration(PAPER_NAMESPACE);
    if (!active)
      throw new Error(
        "Paper semantic index has no active generation; rebuild it first",
      );
    if (active.model.fingerprint !== this.model.fingerprint)
      throw new Error("Paper semantic index model changed; rebuild it before updating");
    return active;
  }

  private requireSourceProvider(): PaperSemanticSourceProvider {
    if (!this.paperSourceProvider)
      throw new Error("Paper semantic source provider is not configured");
    return this.paperSourceProvider;
  }
}

async function* toAsyncIterable<T>(
  source: Iterable<T> | AsyncIterable<T>,
): AsyncIterable<T> {
  for await (const value of source) yield value;
}
