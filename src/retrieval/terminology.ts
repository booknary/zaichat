import {
  RetrievalConcept,
  RetrievalQuery,
  SearchIntent,
  TerminologyConfidence,
  TerminologyOrigin,
  TerminologyRelation,
  TerminologyVariant,
} from "../core/types";

const RELATIONS = new Set<TerminologyRelation>([
  "canonical",
  "exact_synonym",
  "established_term",
  "abbreviation",
  "lexical_variant",
  "rhetorical_paraphrase",
  "broader_term",
  "narrower_term",
  "related_term",
]);
const CONFIDENCES = new Set<TerminologyConfidence>(["high", "medium", "low"]);
const ORIGINS = new Set<TerminologyOrigin>(["model_inferred", "candidate_observed"]);
const INTENTS = new Set<SearchIntent>([
  "known_item",
  "remembered_item",
  "topic",
  "method_use",
  "claim_evidence",
  "synthesis",
]);

const RELATION_WEIGHTS: Record<TerminologyRelation, number> = {
  canonical: 1,
  exact_synonym: 0.98,
  established_term: 0.94,
  abbreviation: 0.88,
  lexical_variant: 0.84,
  rhetorical_paraphrase: 0.72,
  broader_term: 0.48,
  narrower_term: 0.55,
  related_term: 0.3,
};
const CONFIDENCE_WEIGHTS: Record<TerminologyConfidence, number> = {
  high: 1,
  medium: 0.78,
  low: 0.5,
};

export interface SelectedRecallRoute {
  term: string;
  conceptLabels: string[];
  quality: number;
  tier: 1 | 2 | 3;
  origins: TerminologyOrigin[];
}

export interface TerminologyDiagnostics {
  intent: SearchIntent;
  discipline: string;
  subfield: string;
  concepts: Array<{
    label: string;
    role: RetrievalConcept["role"];
    canonical: string;
    selected: TerminologyVariant[];
    fallback: TerminologyVariant[];
  }>;
  firstRoundRoutes: string[];
  fallbackRoutes: string[];
  candidateObservedTerms: string[];
}

export function normalizeSearchIntent(value: unknown): SearchIntent {
  return INTENTS.has(value as SearchIntent) ? (value as SearchIntent) : "topic";
}

export function normalizeTerminologyConcepts(
  value: unknown,
  legacyRequired: string[][],
  legacyOptional: string[][],
): RetrievalConcept[] {
  const structured = Array.isArray(value)
    ? value
        .slice(0, 12)
        .map(normalizeConcept)
        .filter((concept): concept is RetrievalConcept => Boolean(concept))
    : [];
  if (structured.length) return structured;
  return [
    ...legacyRequired.map((group, index) => legacyConcept(group, "required", index)),
    ...legacyOptional.map((group, index) => legacyConcept(group, "optional", index)),
  ].filter((concept): concept is RetrievalConcept => Boolean(concept));
}

export function conceptsToLegacyGroups(
  concepts: RetrievalConcept[],
  role: RetrievalConcept["role"],
): string[][] {
  return concepts
    .filter((concept) => concept.role === role)
    .map((concept) => concept.variants.map((variant) => variant.term))
    .filter((group) => group.length);
}

export function terminologyVariantWeight(
  variant: TerminologyVariant,
  intent: SearchIntent = "topic",
): number {
  let relationWeight = RELATION_WEIGHTS[variant.relation];
  if (variant.relation === "rhetorical_paraphrase" && intent === "remembered_item")
    relationWeight = 0.86;
  return relationWeight * CONFIDENCE_WEIGHTS[variant.confidence];
}

export function terminologyVariantTier(
  variant: TerminologyVariant,
  intent: SearchIntent,
): 1 | 2 | 3 {
  if (
    variant.confidence === "low" ||
    ["broader_term", "narrower_term", "related_term"].includes(variant.relation)
  )
    return 3;
  if (variant.relation === "rhetorical_paraphrase")
    return intent === "remembered_item" ? 2 : 3;
  return 1;
}

export function selectRecallRoutes(
  query: RetrievalQuery,
  limit = 36,
): { selected: SelectedRecallRoute[]; fallback: SelectedRecallRoute[] } {
  const intent = normalizeSearchIntent(query.intent);
  const concepts = query.concepts || [];
  const candidates: SelectedRecallRoute[] = [];
  const variantsByConcept = concepts.map((concept) => ({
    concept,
    variants: concept.variants.map((variant) => ({
      variant,
      tier: terminologyVariantTier(variant, intent),
      quality: terminologyVariantWeight(variant, intent),
    })),
  }));

  for (const { concept, variants } of variantsByConcept) {
    for (const { variant, tier, quality } of variants) {
      candidates.push({
        term: variant.term,
        conceptLabels: [concept.label],
        quality: routeQuality(variant.term, quality, 1),
        tier,
        origins: [variant.origin || "model_inferred"],
      });
    }
  }

  const plannerPhrases = [
    ...(query.titleHypotheses || []),
    ...(query.englishQueries || []),
    ...(query.searchCombinations || []),
    ...(query.phrase ? [query.phrase] : []),
  ];
  for (const phrase of plannerPhrases) {
    const matches = routeConceptMatches(phrase, variantsByConcept, intent);
    const strongestTier = matches.length
      ? Math.max(...matches.map((match) => match.tier))
      : 2;
    const semanticQuality = matches.length
      ? matches.reduce((sum, match) => sum + match.quality, 0) / matches.length
      : 0.5;
    candidates.push({
      term: phrase,
      conceptLabels: matches.map((match) => match.label),
      quality: routeQuality(phrase, semanticQuality, matches.length),
      tier: strongestTier as 1 | 2 | 3,
      origins: uniqueOrigins(matches.flatMap((match) => match.origins)),
    });
  }

  const strongest = variantsByConcept.map(({ concept, variants }) => ({
    concept,
    match: [...variants]
      .filter(({ tier }) => tier < 3)
      .sort((left, right) => right.quality - left.quality)[0],
  }));
  for (let left = 0; left < strongest.length; left++) {
    for (let right = left + 1; right < strongest.length; right++) {
      const first = strongest[left];
      const second = strongest[right];
      if (!first.match || !second.match) continue;
      const term = `${first.match.variant.term} ${second.match.variant.term}`;
      candidates.push({
        term,
        conceptLabels: [first.concept.label, second.concept.label],
        quality: routeQuality(
          term,
          (first.match.quality + second.match.quality) / 2,
          2,
        ),
        tier: Math.max(first.match.tier, second.match.tier) as 1 | 2 | 3,
        origins: uniqueOrigins([
          first.match.variant.origin || "model_inferred",
          second.match.variant.origin || "model_inferred",
        ]),
      });
      if (candidates.length >= 120) break;
    }
    if (candidates.length >= 120) break;
  }

  const deduped = dedupeRoutes(candidates);
  // Tier-3 broader/narrower/related routes remain auditable fallbacks even on
  // revision. A candidate-observed true synonym should be classified as an
  // established or lexical term; a merely related mechanism must never replace
  // an explicit required concept just because weak first-pass candidates used it.
  const eligible = deduped.filter((route) => route.tier < 3);
  const fallback = deduped
    .filter((route) => route.tier === 3)
    .sort(compareRoutes)
    .slice(0, 24);
  const exploratoryTerms =
    intent === "remembered_item"
      ? new Set(
          concepts.flatMap((concept) =>
            concept.variants
              .filter(
                (variant) =>
                  variant.confidence === "low" &&
                  [
                    "exact_synonym",
                    "established_term",
                    "lexical_variant",
                    "rhetorical_paraphrase",
                  ].includes(variant.relation),
              )
              .map((variant) => cleanText(variant.term)),
          ),
        )
      : new Set<string>();
  const exploration = diverseRouteSelection(
    deduped.filter((route) => exploratoryTerms.has(cleanText(route.term))),
    concepts,
    Math.min(4, Math.floor(limit / 4)),
  );
  return {
    selected: [
      ...diverseRouteSelection(
        eligible,
        concepts,
        Math.max(0, limit - exploration.length),
      ),
      ...exploration,
    ],
    fallback,
  };
}

export function terminologyDiagnostics(query: RetrievalQuery): TerminologyDiagnostics {
  const intent = normalizeSearchIntent(query.intent);
  const routes = selectRecallRoutes(query, 36);
  return {
    intent,
    discipline: cleanText(query.discipline) || "unspecified",
    subfield: cleanText(query.subfield) || "unspecified",
    concepts: (query.concepts || []).slice(0, 8).map((concept) => {
      const selected = concept.variants.filter(
        (variant) => terminologyVariantTier(variant, intent) < 3,
      );
      const fallback = concept.variants.filter(
        (variant) => terminologyVariantTier(variant, intent) === 3,
      );
      return {
        label: concept.label,
        role: concept.role,
        canonical:
          concept.variants.find((variant) => variant.relation === "canonical")?.term ||
          concept.variants[0]?.term ||
          concept.label,
        selected: selected.slice(0, 5),
        fallback: fallback.slice(0, 4),
      };
    }),
    firstRoundRoutes: routes.selected.map((route) => route.term),
    fallbackRoutes: routes.fallback.map((route) => route.term),
    candidateObservedTerms: [
      ...new Set(
        (query.concepts || []).flatMap((concept) =>
          concept.variants
            .filter((variant) => variant.origin === "candidate_observed")
            .map((variant) => variant.term),
        ),
      ),
    ].slice(0, 12),
  };
}

function normalizeConcept(value: unknown): RetrievalConcept | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as any;
  const label = cleanText(source.label);
  const meaning = cleanText(source.meaning, 600);
  const role = source.role === "optional" ? "optional" : "required";
  const rawVariants: unknown[] = Array.isArray(source.variants) ? source.variants : [];
  const variants = rawVariants.length
    ? rawVariants
        .slice(0, 12)
        .map(normalizeVariant)
        .filter((variant): variant is TerminologyVariant => Boolean(variant))
    : [];
  if (!label && !variants.length) return undefined;
  if (!variants.length && label)
    variants.push({
      term: label,
      relation: "canonical",
      confidence: "high",
      origin: "model_inferred",
    });
  return {
    label: label || variants[0].term,
    meaning: meaning || label || variants[0].term,
    role,
    variants: dedupeVariants(variants),
  };
}

function normalizeVariant(value: unknown): TerminologyVariant | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as any;
  const term = cleanText(source.term);
  if (!term) return undefined;
  const relation = RELATIONS.has(source.relation)
    ? (source.relation as TerminologyRelation)
    : "related_term";
  const confidence = CONFIDENCES.has(source.confidence)
    ? (source.confidence as TerminologyConfidence)
    : "low";
  const origin = ORIGINS.has(source.origin)
    ? (source.origin as TerminologyOrigin)
    : "model_inferred";
  return { term, relation, confidence, origin };
}

function legacyConcept(
  group: string[],
  role: RetrievalConcept["role"],
  index: number,
): RetrievalConcept | undefined {
  const terms = [...new Set(group.map((term) => cleanText(term)).filter(Boolean))];
  if (!terms.length) return undefined;
  return {
    label: terms[0] || `${role}-${index + 1}`,
    meaning: terms[0] || "",
    role,
    variants: terms.map((term, termIndex) => ({
      term,
      relation: termIndex === 0 ? "canonical" : "established_term",
      confidence: termIndex === 0 ? "high" : "medium",
      origin: "model_inferred",
    })),
  };
}

function routeConceptMatches(
  phrase: string,
  concepts: Array<{
    concept: RetrievalConcept;
    variants: Array<{
      variant: TerminologyVariant;
      tier: 1 | 2 | 3;
      quality: number;
    }>;
  }>,
  intent: SearchIntent,
): Array<{
  label: string;
  quality: number;
  tier: 1 | 2 | 3;
  origins: TerminologyOrigin[];
}> {
  const normalizedPhrase = normalized(phrase);
  return concepts.flatMap(({ concept, variants }) => {
    const matches = variants
      .map(({ variant, tier }) => ({
        variant,
        tier,
        overlap: tokenOverlap(normalizedPhrase, normalized(variant.term)),
      }))
      .filter(({ overlap }) => overlap >= 0.8)
      .sort(
        (left, right) =>
          right.overlap * terminologyVariantWeight(right.variant, intent) -
          left.overlap * terminologyVariantWeight(left.variant, intent),
      );
    const best = matches[0];
    return best
      ? [
          {
            label: concept.label,
            quality: best.overlap * terminologyVariantWeight(best.variant, intent),
            tier: best.tier,
            origins: [best.variant.origin || "model_inferred"],
          },
        ]
      : [];
  });
}

function diverseRouteSelection(
  routes: SelectedRecallRoute[],
  concepts: RetrievalConcept[],
  limit: number,
): SelectedRecallRoute[] {
  const selected: SelectedRecallRoute[] = [];
  const remaining = [...routes];
  for (const concept of concepts.filter((entry) => entry.role === "required")) {
    const best = remaining
      .filter((route) => route.conceptLabels.includes(concept.label))
      .sort(compareRoutes)[0];
    if (
      best &&
      !selected.some((route) => normalized(route.term) === normalized(best.term))
    )
      selected.push(best);
    if (selected.length >= limit) return selected.slice(0, limit);
  }
  while (selected.length < limit) {
    const candidates = remaining.filter(
      (route) =>
        !selected.some(
          (existing) => normalized(existing.term) === normalized(route.term),
        ),
    );
    if (!candidates.length) break;
    candidates.sort((left, right) => {
      const leftAdjusted = left.quality - maxRedundancy(left, selected) * 0.3;
      const rightAdjusted = right.quality - maxRedundancy(right, selected) * 0.3;
      return rightAdjusted - leftAdjusted || compareRoutes(left, right);
    });
    selected.push(candidates[0]);
  }
  return selected;
}

function routeQuality(term: string, semantic: number, conceptCount: number): number {
  const tokens = tokenList(term);
  const specificity = tokens.length >= 2 ? Math.min(0.16, tokens.length * 0.025) : -0.1;
  const diversity = Math.min(0.24, Math.max(0, conceptCount - 1) * 0.12);
  const distinctive = tokens.some(
    (token) => /\d|[_-]/u.test(token) || token.length >= 8,
  )
    ? 0.06
    : 0;
  return round(semantic + specificity + diversity + distinctive);
}

function compareRoutes(left: SelectedRecallRoute, right: SelectedRecallRoute): number {
  return (
    left.tier - right.tier ||
    right.conceptLabels.length - left.conceptLabels.length ||
    right.quality - left.quality ||
    right.term.length - left.term.length ||
    left.term.localeCompare(right.term)
  );
}

function dedupeRoutes(routes: SelectedRecallRoute[]): SelectedRecallRoute[] {
  const values = new Map<string, SelectedRecallRoute>();
  for (const route of routes) {
    const term = cleanText(route.term);
    if (!term || term.length < 2) continue;
    const key = normalized(term);
    const current = values.get(key);
    const candidate = {
      ...route,
      term,
      conceptLabels: [...new Set(route.conceptLabels)],
      origins: uniqueOrigins(route.origins),
    };
    if (!current || compareRoutes(candidate, current) < 0) values.set(key, candidate);
  }
  return [...values.values()];
}

function dedupeVariants(variants: TerminologyVariant[]): TerminologyVariant[] {
  const values = new Map<string, TerminologyVariant>();
  for (const variant of variants) {
    const key = normalized(variant.term);
    const current = values.get(key);
    if (
      !current ||
      terminologyVariantWeight(variant) > terminologyVariantWeight(current)
    )
      values.set(key, variant);
  }
  return [...values.values()];
}

function maxRedundancy(
  route: SelectedRecallRoute,
  selected: SelectedRecallRoute[],
): number {
  return Math.max(
    0,
    ...selected.map((existing) =>
      jaccard(new Set(tokenList(route.term)), new Set(tokenList(existing.term))),
    ),
  );
}

function tokenOverlap(text: string, term: string): number {
  if (!text || !term) return 0;
  if (text.includes(term)) return 1;
  const textTokens = new Set(tokenList(text));
  const termTokens = tokenList(term);
  if (!termTokens.length) return 0;
  return termTokens.filter((token) => textTokens.has(token)).length / termTokens.length;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / (left.size + right.size - intersection);
}

function tokenList(value: string): string[] {
  return normalized(value).match(/[a-z0-9][a-z0-9_-]*|[\u3400-\u9fff]+/gu) || [];
}

function cleanText(value: unknown, max = 240): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueOrigins(values: TerminologyOrigin[]): TerminologyOrigin[] {
  return [
    ...new Set(values.length ? values : ["model_inferred"]),
  ] as TerminologyOrigin[];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
