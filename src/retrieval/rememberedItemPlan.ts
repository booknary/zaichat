import { RetrievalQuery } from "../core/types";

const MIN_HYPOTHESES = 4;
const MIN_DIVERSE_HYPOTHESES = 3;

/**
 * Enforces route diversity for remembered-item searches without knowing the
 * discipline or supplying any vocabulary. The model remains responsible for
 * reconstructing plausible wording; the plugin only rejects missing or
 * mechanically duplicated routes.
 */
export function rememberedItemPlanIssues(query: RetrievalQuery): string[] {
  if (query.intent !== "remembered_item") return [];
  const hypotheses = unique(query.titleHypotheses || []);
  const issues: string[] = [];
  if (hypotheses.length < MIN_HYPOTHESES)
    issues.push(
      `remembered_item requires at least ${MIN_HYPOTHESES} distinct English title hypotheses`,
    );
  if (hypotheses.filter(hasEnglishWords).length < MIN_HYPOTHESES)
    issues.push("remembered_item title hypotheses must contain English wording");
  if (diverseHypothesisCount(hypotheses) < MIN_DIVERSE_HYPOTHESES)
    issues.push(
      "remembered_item title hypotheses need at least three materially different lexical or rhetorical formulations, not only reordered words",
    );
  for (const concept of (query.concepts || []).filter(
    (entry) => entry.role === "required",
  )) {
    const englishVariants = concept.variants
      .filter(
        (variant) =>
          variant.confidence !== "low" &&
          !["related_term", "broader_term", "narrower_term"].includes(variant.relation),
      )
      .map((variant) => variant.term)
      .filter(hasEnglishTerm);
    if (!englishVariants.length) {
      issues.push(
        `required concept "${concept.label}" needs at least one English terminology variant`,
      );
      continue;
    }
    const covered = hypotheses.filter((hypothesis) =>
      englishVariants.some((variant) => termCoverage(hypothesis, variant) >= 0.67),
    ).length;
    if (covered < 1)
      issues.push(
        `required concept "${concept.label}" must be represented in at least one title hypothesis`,
      );
  }
  return issues;
}

export function diverseHypothesisCount(values: string[]): number {
  const selected: Set<string>[] = [];
  for (const value of unique(values)) {
    const tokens = tokenSet(value);
    if (tokens.size < 3) continue;
    if (selected.every((current) => jaccard(tokens, current) < 0.75))
      selected.push(tokens);
  }
  return selected.length;
}

function hasEnglishWords(value: string): boolean {
  return (value.match(/[a-z][a-z-]{1,}/giu) || []).length >= 3;
}

function hasEnglishTerm(value: string): boolean {
  return /[a-z][a-z-]{1,}/iu.test(value);
}

function termCoverage(text: string, term: string): number {
  const textTokens = tokenSet(text);
  const termTokens = [...tokenSet(term)];
  if (!termTokens.length) return 0;
  return termTokens.filter((token) => textTokens.has(token)).length / termTokens.length;
}

function unique(values: string[]): string[] {
  const result = new Map<string, string>();
  for (const value of values) {
    const cleaned = value.normalize("NFKC").replace(/\s+/g, " ").trim();
    const key = cleaned.toLocaleLowerCase();
    if (cleaned && !result.has(key)) result.set(key, cleaned);
  }
  return [...result.values()];
}

function tokenSet(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9-]*/gu) || [])
      .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
      .map(canonicalToken),
  );
}

function canonicalToken(value: string): string {
  let token = value.replace(/-/g, "");
  if (token.length > 6) token = token.replace(/(ically|edly|ingly|ally|ness)$/u, "");
  if (token.length > 4) token = token.replace(/(ing|ed|ies|es|s)$/u, "");
  if (token.endsWith("e") && token.length > 5) token = token.slice(0, -1);
  return token;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / (left.size + right.size - intersection);
}

const STOPWORDS = new Set([
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
