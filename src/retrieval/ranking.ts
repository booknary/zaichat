import {
  EvidenceSnippet,
  RetrievalConcept,
  RetrievalQuery,
  RetrievedItem,
  SearchIntent,
} from "../core/types";
import {
  conceptsToLegacyGroups,
  normalizeSearchIntent,
  normalizeTerminologyConcepts,
  selectRecallRoutes,
  terminologyVariantWeight,
} from "./terminology";

const FIELD_WEIGHTS: Record<
  Exclude<EvidenceSnippet["field"], "fulltext"> | "fulltext",
  number
> = {
  title: 5,
  tag: 4,
  abstract: 3,
  note: 2.5,
  annotation: 2.5,
  fulltext: 2,
  author: 2,
};

export type SearchDocument = Omit<RetrievedItem, "score" | "matchedFields">;

export function normalizeQuery(value: unknown): RetrievalQuery {
  const source = value && typeof value === "object" ? (value as any) : {};
  const legacyRequired = normalizeGroups(source.required);
  const legacyOptional = normalizeGroups(source.optional);
  const concepts = normalizeTerminologyConcepts(
    source.concepts,
    legacyRequired,
    legacyOptional,
  );
  return {
    discipline: cleanDescriptor(source.discipline, 200),
    subfield: cleanDescriptor(source.subfield, 240),
    intent: normalizeSearchIntent(source.intent),
    concepts,
    phrase: cleanTerm(source.phrase),
    exactTitles: normalizeTitles(source.exactTitles),
    titleHypotheses: normalizeTitleHypotheses(source.titleHypotheses),
    englishQueries: normalizeTerms(source.englishQueries),
    searchCombinations: normalizeSearchCombinations(source.searchCombinations),
    required: conceptsToLegacyGroups(concepts, "required"),
    optional: conceptsToLegacyGroups(concepts, "optional"),
    excluded: normalizeTerms(source.excluded),
    excludedTitles: normalizeTitles(source.excludedTitles),
    authors: normalizeTerms(source.authors),
    yearMin: normalizeYear(source.yearMin),
    yearMax: normalizeYear(source.yearMax),
    itemTypes: normalizeTerms(source.itemTypes),
    languages: normalizeTerms(source.languages),
    collectionKeys: normalizeTerms(source.collectionKeys).map((key) =>
      key.toUpperCase(),
    ),
    limit: Math.max(1, Math.min(50, Number(source.limit) || 20)),
  };
}

export function recallTerms(query: RetrievalQuery, limit = 36): string[] {
  return selectRecallRoutes(query, limit).selected.map((route) => route.term);
}

export function rankDocuments(
  documents: SearchDocument[],
  rawQuery: RetrievalQuery,
): RetrievedItem[] {
  const query = normalizeQuery(rawQuery);
  const match = createTextMatcher();
  return documents
    .filter((document) => passesHardFilters(document, query))
    .map((document) => scoreDocument(document, query, match))
    .filter(
      (document) =>
        document.score > 0 ||
        (!query.required.length && !query.optional.length && Boolean(query.phrase)),
    )
    .sort((left, right) => compareRanked(left, right, query))
    .slice(0, query.limit);
}

export function scoreDocument(
  document: SearchDocument,
  query: RetrievalQuery,
  match = termMatchRatio,
): RetrievedItem {
  const intent = normalizeSearchIntent(query.intent);
  const requiredConcepts = (query.concepts || []).filter(
    (concept) => concept.role === "required",
  );
  const optionalConcepts = (query.concepts || []).filter(
    (concept) => concept.role === "optional",
  );
  const fields: Array<{ field: EvidenceSnippet["field"]; values: string[] }> = [
    { field: "title", values: [document.title] },
    { field: "tag", values: document.tags },
    { field: "abstract", values: [document.abstract] },
    { field: "note", values: document.notes || [] },
    { field: "annotation", values: document.annotations || [] },
    { field: "fulltext", values: document.fulltext || [] },
    { field: "author", values: document.authors },
  ];
  const matchedFields: EvidenceSnippet["field"][] = [];
  let weightedFieldEvidence = 0;
  let totalWeight = 0;
  for (const { field, values } of fields) {
    const weight = FIELD_WEIGHTS[field];
    totalWeight += weight;
    const fieldText = normalizeText(values.join(" "));
    const requiredRatio = conceptCoverage(fieldText, requiredConcepts, intent, match);
    const optionalRatio = conceptCoverage(fieldText, optionalConcepts, intent, match);
    const phraseRatio = query.phrase ? match(fieldText, query.phrase) : 0;
    const evidenceRatio = requiredConcepts.length
      ? requiredRatio * 0.85 + optionalRatio * 0.15
      : optionalConcepts.length
        ? optionalRatio
        : phraseRatio;
    if (Math.max(requiredRatio, optionalRatio, phraseRatio) > 0)
      matchedFields.push(field);
    weightedFieldEvidence += evidenceRatio * weight;
  }
  const allText = documentText(document);
  const titleQuality = titleMatchQuality(document.title, query);
  const requiredCoverage = conceptCoverage(allText, requiredConcepts, intent, match);
  const optionalCoverage = conceptCoverage(allText, optionalConcepts, intent, match);
  const queryTerms = [
    ...(query.titleHypotheses || []),
    ...(query.englishQueries || []),
    ...(query.searchCombinations || []),
  ];
  const queryFamilyEvidence = Math.max(
    0,
    ...queryTerms.map((term) => match(allText, term)),
  );
  const distinctivePhraseEvidence = Math.max(
    0,
    ...queryTerms.map((term) => exactDistinctivePhraseEvidence(allText, term)),
  );
  const exactBonus = titleQuality
    ? Math.min(0.3, titleQuality * 0.3)
    : query.phrase && allText.includes(normalizeText(query.phrase))
      ? 0.08
      : 0;
  const fieldCoverageBonus = Math.min(
    0.06,
    Math.max(0, matchedFields.length - 1) * 0.015,
  );
  const hasFulltext = matchedFields.includes("fulltext");
  const hasMetadata = matchedFields.some((field) =>
    ["title", "abstract", "tag", "author"].includes(field),
  );
  const multiSourceBonus = hasFulltext && hasMetadata ? 0.06 : 0;
  const provenanceBonus = Math.min(
    0.04,
    Math.max(0, new Set(document.provenance || []).size - 1) * 0.02,
  );
  return {
    ...document,
    matchedFields,
    score: round01(
      (totalWeight ? (weightedFieldEvidence / totalWeight) * 0.42 : 0) +
        requiredCoverage * 0.34 +
        optionalCoverage * 0.06 +
        queryFamilyEvidence * 0.12 +
        distinctivePhraseEvidence * 0.12 +
        exactBonus +
        fieldCoverageBonus +
        multiSourceBonus +
        provenanceBonus,
    ),
  };
}

export function conceptCoverage(
  text: string,
  concepts: RetrievalConcept[],
  intent: SearchIntent = "topic",
  match = termMatchRatio,
): number {
  if (!concepts.length) return 0;
  return (
    concepts.reduce(
      (sum, concept) =>
        sum +
        Math.max(
          0,
          ...concept.variants.map(
            (variant) =>
              match(text, variant.term) * terminologyVariantWeight(variant, intent),
          ),
        ),
      0,
    ) / concepts.length
  );
}

function exactDistinctivePhraseEvidence(text: string, term: string): number {
  const normalized = normalizeText(term);
  const tokens = recallTokens(normalized);
  if (tokens.length < 2 || !text.includes(normalized)) return 0;
  const distinctiveTokens = tokens.filter(
    (token) => /\d|[_-]/u.test(token) || token.length >= 6,
  );
  return distinctiveTokens.length ? 1 : 0.65;
}

export function titleMatchQuality(title: string, query: RetrievalQuery): number {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle) return 0;
  let best = 0;
  for (const raw of query.exactTitles || []) {
    const expected = normalizeText(raw);
    if (!expected) continue;
    if (normalizedTitle === expected) return 1;
    if (normalizedTitle.includes(expected) || expected.includes(normalizedTitle))
      best = Math.max(best, 0.92);
    const titleTokens = tokenSet(normalizedTitle);
    const expectedTokens = tokenSet(expected);
    const overlap = [...expectedTokens].filter((token) =>
      titleTokens.has(token),
    ).length;
    if (expectedTokens.size)
      best = Math.max(best, (overlap / expectedTokens.size) * 0.85);
  }
  return best;
}

export function passesHardFilters(
  document: SearchDocument,
  query: RetrievalQuery,
): boolean {
  const text = documentText(document);
  if (query.excluded.some((term) => includesTerm(text, term))) return false;
  if (
    query.excludedTitles?.some(
      (title) => normalizeText(title) === normalizeText(document.title),
    )
  )
    return false;
  if (titleMatchQuality(document.title, query) >= 0.82)
    return passesFieldFilters(document, query);
  return passesFieldFilters(document, query);
}

function passesFieldFilters(document: SearchDocument, query: RetrievalQuery): boolean {
  if (
    query.authors?.length &&
    !query.authors.some((author) =>
      includesTerm(normalizeText(document.authors.join(" ")), author),
    )
  )
    return false;
  if (query.yearMin && (!document.year || document.year < query.yearMin)) return false;
  if (query.yearMax && (!document.year || document.year > query.yearMax)) return false;
  if (
    query.itemTypes?.length &&
    !query.itemTypes.map(normalizeText).includes(normalizeText(document.itemType || ""))
  )
    return false;
  if (
    query.languages?.length &&
    !query.languages
      .map(normalizeText)
      .some((language) => normalizeText(document.language || "").includes(language))
  )
    return false;
  if (
    query.collectionKeys?.length &&
    !query.collectionKeys.some((key) => document.collections?.includes(key))
  )
    return false;
  return true;
}

function compareRanked(
  left: RetrievedItem,
  right: RetrievedItem,
  query: RetrievalQuery,
): number {
  return (
    titleMatchQuality(right.title, query) - titleMatchQuality(left.title, query) ||
    right.score - left.score ||
    left.title.localeCompare(right.title)
  );
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(" ").filter((token) => token.length >= 2));
}

function documentText(document: SearchDocument): string {
  return normalizeText(
    [
      document.title,
      document.abstract,
      ...document.authors,
      ...document.tags,
      ...(document.notes || []),
      ...(document.annotations || []),
      ...(document.fulltext || []),
    ].join(" "),
  );
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesTerm(text: string, term: string): boolean {
  return termMatchRatio(text, term) >= 0.8;
}

export function termMatchRatio(text: string, term: string): number {
  const normalizedText = normalizeText(text);
  const normalizedTerm = normalizeText(term);
  if (!normalizedText || !normalizedTerm) return 0;
  if (normalizedText.includes(normalizedTerm)) return 1;
  const textTokens = new Set(recallTokens(normalizedText).map(canonicalToken));
  const termTokens = recallTokens(normalizedTerm);
  if (!termTokens.length) return 0;
  const matched = termTokens.filter((token) =>
    textTokens.has(canonicalToken(token)),
  ).length;
  return matched / termTokens.length;
}

/** Per-ranking cache: reuse tokenization without changing lexical scores. */
export function createTextMatcher(): typeof termMatchRatio {
  const texts = new Map<string, { normalized: string; tokens: Set<string> }>();
  const terms = new Map<string, { normalized: string; tokens: string[] }>();
  return (text, term) => {
    let left = texts.get(text);
    if (!left) {
      const normalized = normalizeText(text);
      left = {
        normalized,
        tokens: new Set(recallTokens(normalized).map(canonicalToken)),
      };
      texts.set(text, left);
    }
    let right = terms.get(term);
    if (!right) {
      const normalized = normalizeText(term);
      right = { normalized, tokens: recallTokens(normalized).map(canonicalToken) };
      terms.set(term, right);
    }
    if (!left.normalized || !right.normalized) return 0;
    if (left.normalized.includes(right.normalized)) return 1;
    if (!right.tokens.length) return 0;
    return (
      right.tokens.filter((token) => left!.tokens.has(token)).length /
      right.tokens.length
    );
  };
}

function recallTokens(value: string): string[] {
  const normalized = normalizeText(value);
  const segments = normalized.match(/[a-z0-9][a-z0-9-]*|[\u3400-\u9fff]+/gu) || [];
  return segments.filter(
    (token) =>
      /[\u3400-\u9fff]/u.test(token) ||
      (token.length >= 2 && !RECALL_STOPWORDS.has(token)),
  );
}

function canonicalToken(value: string): string {
  let token = value.toLocaleLowerCase().replace(/-/g, "");
  if (token.length > 5) token = token.replace(/(ically|ical|ically|ments?|ness)$/u, "");
  if (token.length > 4) token = token.replace(/(ing|ed|ies|es|s)$/u, "");
  if (token.endsWith("ic") && token.length > 5) token = token.slice(0, -2);
  if (token.endsWith("e") && token.length > 5) token = token.slice(0, -1);
  return token;
}

const RECALL_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "with",
  "into",
  "that",
  "this",
  "about",
  "paper",
  "article",
  "find",
  "please",
]);

function normalizeGroups(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value
    .map((group) =>
      Array.isArray(group) ? normalizeTerms(group) : normalizeTerms([group]),
    )
    .filter((group) => group.length);
}

function normalizeTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanTerm).filter(Boolean) as string[])].slice(0, 50);
}

function normalizeSearchCombinations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((entry) => {
      if (Array.isArray(entry)) return cleanTerm(normalizeTerms(entry).join(" "));
      return cleanTerm(entry);
    })
    .filter(Boolean) as string[];
  return [...new Set(normalized)].slice(0, 50);
}

function normalizeTitles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.normalize("NFKC").replace(/\s+/g, " ").trim())
        .filter((entry) => entry.length >= 4 && entry.length <= 500),
    ),
  ].slice(0, 4);
}

function normalizeTitleHypotheses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.normalize("NFKC").replace(/\s+/g, " ").trim())
        .filter((entry) => entry.length >= 8 && entry.length <= 300),
    ),
  ].slice(0, 8);
}

function cleanTerm(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeText(value);
  return normalized && normalized.length <= 200 ? normalized : undefined;
}

function cleanDescriptor(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function normalizeYear(value: unknown): number | undefined {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1500 && year <= 2200 ? year : undefined;
}

function round01(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}
