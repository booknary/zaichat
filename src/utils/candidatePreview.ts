/** Select one verbatim window for presentation only; never score or reorder papers. */
export function candidateExcerpt(text: string, terms: string[], limit: number): string {
  if (!text || limit <= 0) return "";
  if (text.length <= limit) return text;
  if (limit <= 2) return text.slice(0, limit);
  const needles = [...new Set(terms.map((term) => term.trim().toLocaleLowerCase()))]
    .filter((term) => term.length >= 2)
    .slice(0, 64);
  const patterns = needles.map((term) => {
    const escaped = term.replace(/[$.*+?^{}()|[\]\\]/gu, "\\$&");
    return new RegExp(
      (/^[a-z0-9]/iu.test(term) ? "(?<![\\p{L}\\p{N}])" : "") +
        escaped +
        (/[a-z0-9]$/iu.test(term) ? "(?![\\p{L}\\p{N}])" : ""),
      "iu",
    );
  });
  let bestStart = 0;
  let bestEnd = text.length;
  let bestScore = 0;
  for (const sentence of text.matchAll(/[^。！？!?\n.]+(?:[。！？!?\n.]|$)/gu)) {
    let first = -1;
    let score = 0;
    for (const pattern of patterns) {
      const hit = pattern.exec(sentence[0]);
      if (!hit) continue;
      score++;
      first = first < 0 ? hit.index : Math.min(first, hit.index);
    }
    if (score <= bestScore) continue;
    bestScore = score;
    const offset = sentence.index!;
    bestStart = offset + (first >= limit - 2 ? Math.max(0, first - 40) : 0);
    bestEnd = offset + sentence[0].length;
  }
  const prefix = bestStart > 0 ? "…" : "";
  const end = Math.min(bestEnd, bestStart + limit - prefix.length - 1);
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(bestStart, end).trim() + suffix;
}

export function candidateAuthors(
  candidate: {
    authors?: string[];
    authorCount?: number | null;
    authorsTruncated?: boolean;
    readWarnings?: string[];
  },
  limit: number,
) {
  const original = candidate.authors || [];
  const unknown =
    candidate.authorCount === null || candidate.readWarnings?.includes("authors");
  const authorCount = unknown
    ? null
    : (candidate.authorCount ?? (candidate.authorsTruncated ? null : original.length));
  const authors = original.slice(0, limit);
  return {
    authors,
    authorCount,
    authorsTruncated:
      authorCount === null ||
      candidate.authorsTruncated === true ||
      authors.length < authorCount,
  };
}
