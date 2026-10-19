import { PaperSemanticSource } from "./types";

const CACHE_VERSION = 1;
const BATCH_SIZE = 50;
const MAX_ABSTRACT_CHARS = 30_000;
const NEGATIVE_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface AbstractEnrichmentCacheEntry {
  doi: string;
  title: string;
  abstract: string;
  fetchedAt: string;
  source: "openalex";
}

export interface AbstractEnrichmentCache {
  read(): Promise<AbstractEnrichmentCacheEntry[]>;
  write(entries: AbstractEnrichmentCacheEntry[]): Promise<void>;
}

export interface PaperAbstractEnricher {
  enrich(source: PaperSemanticSource): Promise<PaperSemanticSource>;
  prefetch(sources: PaperSemanticSource[]): Promise<void>;
}

export interface OpenAlexAbstractEnricherOptions {
  enabled: () => boolean;
  fetchJSON?: (url: string) => Promise<unknown>;
  now?: () => Date;
}

/** Fetches only by exact DOI and never writes the result back to Zotero. */
export class OpenAlexAbstractEnricher implements PaperAbstractEnricher {
  private loaded = false;
  private entries = new Map<string, AbstractEnrichmentCacheEntry>();

  constructor(
    private readonly cache: AbstractEnrichmentCache,
    private readonly options: OpenAlexAbstractEnricherOptions,
  ) {}

  async enrich(source: PaperSemanticSource): Promise<PaperSemanticSource> {
    if (!this.options.enabled() || source.abstract.trim()) return source;
    const doi = normalizeDOI(source.doi || "");
    if (!doi) return source;
    await this.load();
    let entry = this.entries.get(doi);
    if (!entry || this.negativeExpired(entry)) {
      await this.fetchAndCache([{ ...source, doi }]).catch(() => undefined);
      entry = this.entries.get(doi);
    }
    return entry?.abstract && titlesAgree(source.title, entry.title)
      ? { ...source, abstract: entry.abstract, abstractSource: "openalex" }
      : source;
  }

  async prefetch(sources: PaperSemanticSource[]): Promise<void> {
    if (!this.options.enabled()) return;
    await this.load();
    const missing = sources
      .filter((source) => !source.abstract.trim())
      .map((source) => ({ ...source, doi: normalizeDOI(source.doi || "") }))
      .filter(
        (source): source is PaperSemanticSource & { doi: string } =>
          Boolean(source.doi) &&
          (!this.entries.has(source.doi) ||
            this.negativeExpired(this.entries.get(source.doi)!)),
      );
    for (let index = 0; index < missing.length; index += BATCH_SIZE)
      await this.fetchAndCache(missing.slice(index, index + BATCH_SIZE)).catch(
        () => undefined,
      );
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    for (const entry of await this.cache.read().catch(() => [])) {
      const doi = normalizeDOI(entry.doi);
      if (doi && entry.source === "openalex") this.entries.set(doi, { ...entry, doi });
    }
  }

  private async fetchAndCache(
    sources: Array<PaperSemanticSource & { doi: string }>,
  ): Promise<void> {
    if (!sources.length) return;
    const requestDOIs = [...new Set(sources.map((source) => source.doi))];
    const params = new URLSearchParams({
      filter: `doi:${requestDOIs.join("|")}`,
      select: "doi,title,abstract_inverted_index",
      per_page: String(requestDOIs.length),
    });
    const payload = await (this.options.fetchJSON || defaultFetchJSON)(
      `https://api.openalex.org/works?${params.toString()}`,
    );
    const results = Array.isArray((payload as any)?.results)
      ? ((payload as any).results as any[])
      : [];
    const sourceByDOI = new Map(sources.map((source) => [source.doi, source]));
    const accepted = new Set<string>();
    for (const result of results) {
      const doi = normalizeDOI(String(result?.doi || ""));
      const source = sourceByDOI.get(doi);
      const title = cleanText(result?.title, 1000);
      const abstract = invertedAbstract(result?.abstract_inverted_index);
      if (!source || !abstract || !titlesAgree(source.title, title)) continue;
      this.entries.set(doi, {
        doi,
        title,
        abstract,
        fetchedAt: (this.options.now?.() || new Date()).toISOString(),
        source: "openalex",
      });
      accepted.add(doi);
    }
    for (const source of sources) {
      if (accepted.has(source.doi)) continue;
      this.entries.set(source.doi, {
        doi: source.doi,
        title: source.title,
        abstract: "",
        fetchedAt: (this.options.now?.() || new Date()).toISOString(),
        source: "openalex",
      });
    }
    await this.cache.write([...this.entries.values()]);
  }

  private negativeExpired(entry: AbstractEnrichmentCacheEntry): boolean {
    if (entry.abstract) return false;
    const fetched = Date.parse(entry.fetchedAt);
    const now = (this.options.now?.() || new Date()).getTime();
    return !Number.isFinite(fetched) || now - fetched >= NEGATIVE_CACHE_MS;
  }
}

export class JSONAbstractEnrichmentCache implements AbstractEnrichmentCache {
  constructor(
    private readonly fileSystem: {
      exists(path: string): Promise<boolean>;
      readText(path: string): Promise<string>;
      writeText(path: string, value: string): Promise<void>;
      mkdir(path: string): Promise<void>;
      parent(path: string): string;
    },
    private readonly path: string,
  ) {}

  async read(): Promise<AbstractEnrichmentCacheEntry[]> {
    if (!(await this.fileSystem.exists(this.path))) return [];
    const parsed = JSON.parse(await this.fileSystem.readText(this.path));
    return parsed?.version === CACHE_VERSION && Array.isArray(parsed.entries)
      ? parsed.entries
      : [];
  }

  async write(entries: AbstractEnrichmentCacheEntry[]): Promise<void> {
    await this.fileSystem.mkdir(this.fileSystem.parent(this.path));
    await this.fileSystem.writeText(
      this.path,
      `${JSON.stringify({ version: CACHE_VERSION, entries }, null, 2)}\n`,
    );
  }
}

export function invertedAbstract(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const positioned: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions)
      if (Number.isInteger(position) && Number(position) >= 0)
        positioned.push([Number(position), cleanText(word, 200)]);
  }
  return positioned
    .filter(([, word]) => Boolean(word))
    .sort((left, right) => left[0] - right[0])
    .map(([, word]) => word)
    .join(" ")
    .slice(0, MAX_ABSTRACT_CHARS);
}

export function titlesAgree(left: string, right: string): boolean {
  const first = titleTokens(left);
  const second = titleTokens(right);
  if (!first.size || !second.size) return false;
  const intersection = [...first].filter((token) => second.has(token)).length;
  return intersection / Math.min(first.size, second.size) >= 0.7;
}

function titleTokens(value: string): Set<string> {
  return new Set(
    cleanText(value, 1000)
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu)
      ?.filter((token) => token.length >= 2 && !TITLE_STOPWORDS.has(token)) || [],
  );
}

function normalizeDOI(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
    .replace(/^doi:\s*/iu, "")
    .toLocaleLowerCase();
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";
}

async function defaultFetchJSON(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Abstract metadata request failed with HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

const TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);
