import { SemanticIndexStore } from "./semanticIndexStore";
import { SemanticEmbeddingProvider, SemanticNamespace } from "./types";

export interface SemanticBenchmarkCase {
  caseID: string;
  query: string;
  relevantItemKeys: string[];
}

export interface BenchmarkSearchProvider {
  search(query: string, limit: number): Promise<string[]>;
}

export interface SemanticBenchmarkCaseResult {
  caseID: string;
  lexicalRecallAt10: number;
  semanticRecallAt10: number;
}

export interface SemanticBenchmarkReport {
  caseCount: number;
  lexicalRecallAt10: number;
  semanticRecallAt10: number;
  cases: SemanticBenchmarkCaseResult[];
}

export async function runSemanticRecallBenchmark(
  cases: SemanticBenchmarkCase[],
  lexical: BenchmarkSearchProvider,
  semantic: BenchmarkSearchProvider,
): Promise<SemanticBenchmarkReport> {
  if (!cases.length) throw new Error("Semantic benchmark requires at least one case");
  const results: SemanticBenchmarkCaseResult[] = [];
  for (const testCase of cases) {
    const relevant = new Set(testCase.relevantItemKeys);
    if (!testCase.caseID || !testCase.query || !relevant.size)
      throw new Error(
        "Semantic benchmark cases require an ID, query, and ground truth",
      );
    const [lexicalKeys, semanticKeys] = await Promise.all([
      lexical.search(testCase.query, 10),
      semantic.search(testCase.query, 10),
    ]);
    results.push({
      caseID: testCase.caseID,
      lexicalRecallAt10: recallAt10(lexicalKeys, relevant),
      semanticRecallAt10: recallAt10(semanticKeys, relevant),
    });
  }
  return {
    caseCount: results.length,
    lexicalRecallAt10: mean(results.map((result) => result.lexicalRecallAt10)),
    semanticRecallAt10: mean(results.map((result) => result.semanticRecallAt10)),
    cases: results,
  };
}

export function createSemanticStoreBenchmarkSearch(
  store: SemanticIndexStore,
  embeddingProvider: SemanticEmbeddingProvider,
  namespace: SemanticNamespace,
): BenchmarkSearchProvider {
  return {
    async search(query: string, limit: number): Promise<string[]> {
      const queryVector = await embeddingProvider.embedQuery(query);
      const hits = await store.searchCosine(
        namespace,
        queryVector,
        Math.min(1000, Math.max(limit * 3, limit)),
      );
      const keys: string[] = [];
      const seen = new Set<string>();
      for (const hit of hits) {
        if (seen.has(hit.itemKey)) continue;
        seen.add(hit.itemKey);
        keys.push(hit.itemKey);
        if (keys.length >= limit) break;
      }
      return keys;
    },
  };
}

function recallAt10(keys: string[], relevant: Set<string>): number {
  const found = new Set(keys.slice(0, 10).filter((key) => relevant.has(key)));
  return found.size / relevant.size;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
