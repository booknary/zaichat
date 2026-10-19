import { ConversationFileStore } from "./conversationRepository";
import { SearchLearningEntry } from "./types";
import { nowISO } from "../utils/ids";
import { normalizeText } from "../retrieval/ranking";

interface PersistedLearning {
  schemaVersion: 1 | 2;
  entries: SearchLearningEntry[];
}

export class SearchLearningRepository {
  private entries: SearchLearningEntry[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ConversationFileStore,
    private readonly path: string,
  ) {}

  async initialize(): Promise<void> {
    if (!(await this.store.exists(this.path))) return;
    try {
      const parsed = JSON.parse(await this.store.read(this.path)) as PersistedLearning;
      this.entries =
        [1, 2].includes(parsed.schemaVersion) && Array.isArray(parsed.entries)
          ? parsed.entries.slice(-100).map(migrateEntry)
          : [];
    } catch (error) {
      globalThis.Zotero?.logError?.(
        new Error(
          `ZaiChat ignored unreadable search learning: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      this.entries = [];
    }
  }

  recordRelevant(query: string, title: string): Promise<void> {
    const normalizedQuery = normalizeText(query).slice(0, 500);
    const normalizedTitle = title.trim().slice(0, 500);
    if (!normalizedQuery || !normalizedTitle) return Promise.resolve();
    const existing = this.entries.find((entry) => entry.query === normalizedQuery);
    const learnedTerms = titleTerms(normalizedTitle);
    if (existing) {
      existing.successfulTitles = [
        ...new Set([...existing.successfulTitles, normalizedTitle]),
      ].slice(-12);
      existing.learnedTerms = [
        ...new Set([...existing.learnedTerms, ...learnedTerms]),
      ].slice(-30);
      existing.successfulCombinations = [
        ...new Set([
          ...existing.successfulCombinations,
          ...learnedCombinations(normalizedTitle),
        ]),
      ].slice(-20);
      existing.rejectedTitles = existing.rejectedTitles.filter(
        (title) => normalizeText(title) !== normalizeText(normalizedTitle),
      );
      existing.updatedAt = nowISO();
    } else {
      this.entries.push({
        query: normalizedQuery,
        successfulTitles: [normalizedTitle],
        rejectedTitles: [],
        learnedTerms,
        successfulCombinations: learnedCombinations(normalizedTitle),
        updatedAt: nowISO(),
      });
      this.entries = this.entries.slice(-100);
    }
    return this.enqueueSave();
  }

  recordIrrelevant(query: string, title: string): Promise<void> {
    const normalizedQuery = normalizeText(query).slice(0, 500);
    const normalizedTitle = title.trim().slice(0, 500);
    if (!normalizedQuery || !normalizedTitle) return Promise.resolve();
    let entry = this.entries.find((value) => value.query === normalizedQuery);
    if (!entry) {
      entry = {
        query: normalizedQuery,
        successfulTitles: [],
        rejectedTitles: [],
        learnedTerms: [],
        successfulCombinations: [],
        updatedAt: nowISO(),
      };
      this.entries.push(entry);
    }
    entry.rejectedTitles = [
      ...new Set([...entry.rejectedTitles, normalizedTitle]),
    ].slice(-30);
    entry.successfulTitles = entry.successfulTitles.filter(
      (value) => normalizeText(value) !== normalizeText(normalizedTitle),
    );
    entry.updatedAt = nowISO();
    this.entries = this.entries.slice(-100);
    return this.enqueueSave();
  }

  contextFor(query: string): string {
    const normalized = normalizeText(query);
    if (!normalized) return "";
    const queryTokens = tokenSet(normalized);
    return this.entries
      .map((entry) => ({ entry, score: overlap(queryTokens, tokenSet(entry.query)) }))
      .filter(({ score }) => score >= 0.2)
      .sort((left, right) => right.score - left.score)
      .slice(0, 5)
      .map(
        ({ entry }) =>
          `Query: ${entry.query}\nConfirmed titles: ${entry.successfulTitles.join(" | ") || "none"}\nRejected titles: ${entry.rejectedTitles.join(" | ") || "none"}\nLearned terms: ${entry.learnedTerms.join(", ")}`,
      )
      .join("\n---\n");
  }

  suggestionsFor(query: string): {
    titles: string[];
    terms: string[];
    combinations: string[];
    rejectedTitles: string[];
  } {
    const normalized = normalizeText(query);
    const queryTokens = tokenSet(normalized);
    const matches = this.entries
      .map((entry) => ({ entry, score: overlap(queryTokens, tokenSet(entry.query)) }))
      .filter(({ score }) => score >= 0.2)
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);
    return {
      titles: [
        ...new Set(matches.flatMap(({ entry }) => entry.successfulTitles)),
      ].slice(0, 4),
      terms: [...new Set(matches.flatMap(({ entry }) => entry.learnedTerms))].slice(
        0,
        12,
      ),
      combinations: [
        ...new Set(matches.flatMap(({ entry }) => entry.successfulCombinations)),
      ].slice(0, 12),
      rejectedTitles: [
        ...new Set(matches.flatMap(({ entry }) => entry.rejectedTitles)),
      ].slice(0, 20),
    };
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private enqueueSave(): Promise<void> {
    const snapshot: PersistedLearning = {
      schemaVersion: 2,
      entries: JSON.parse(JSON.stringify(this.entries)),
    };
    this.writeQueue = this.writeQueue.then(async () => {
      const temp = `${this.path}.tmp`;
      const backup = `${this.path}.bak`;
      await this.store.write(temp, JSON.stringify(snapshot, null, 2));
      if (await this.store.exists(this.path)) {
        if (await this.store.exists(backup)) await this.store.remove(backup);
        await this.store.move(this.path, backup);
      }
      await this.store.move(temp, this.path);
    });
    return this.writeQueue;
  }
}

function migrateEntry(entry: Partial<SearchLearningEntry>): SearchLearningEntry {
  return {
    query: String(entry.query || ""),
    successfulTitles: Array.isArray(entry.successfulTitles)
      ? entry.successfulTitles.map(String)
      : [],
    rejectedTitles: Array.isArray(entry.rejectedTitles)
      ? entry.rejectedTitles.map(String)
      : [],
    learnedTerms: Array.isArray(entry.learnedTerms)
      ? entry.learnedTerms.map(String)
      : [],
    successfulCombinations: Array.isArray(entry.successfulCombinations)
      ? entry.successfulCombinations.map(String)
      : [],
    updatedAt: String(entry.updatedAt || nowISO()),
  };
}

function learnedCombinations(title: string): string[] {
  const terms = titleTerms(title);
  if (terms.length < 2) return [];
  return [terms.slice(0, 4).join(" "), terms.slice(-4).join(" ")].filter(Boolean);
}

function titleTerms(title: string): string[] {
  return [...tokenSet(normalizeText(title))]
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term))
    .slice(0, 24);
}

function tokenSet(value: string): Set<string> {
  const segments = value.split(" ").filter((token) => token.length >= 2);
  const tokens = new Set(segments);
  for (const segment of segments) {
    if (!/[\u3400-\u9fff]/u.test(segment)) continue;
    for (const gram of cjkNgrams(segment, 2)) tokens.add(gram);
  }
  return tokens;
}

function cjkNgrams(value: string, size: number): string[] {
  const chars = [...value];
  return chars
    .slice(0, Math.max(0, chars.length - size + 1))
    .map((_, index) => chars.slice(index, index + size).join(""));
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((token) => right.has(token)).length;
  return shared / Math.min(left.size, right.size);
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "article",
  "paper",
]);
