export interface Passage {
  start: number;
  end: number;
  text: string;
  matchedTerms: string[];
  score: number;
}

// Conservative sentence boundaries: avoid decimal points and common abbreviations.
function alignSentence(text: string, passage: Passage): Passage {
  const raw = text.slice(passage.start, passage.end);
  const boundaries = [
    ...raw.matchAll(/[。！？!?](?:[”"']*)\s*|\.(?:[”"']*)\s+(?=[A-Z\u4e00-\u9fff])/g),
  ]
    .filter(
      (match) =>
        !/(?:\b(?:fig|eq|dr|et al)|\b[A-Z])\.$/i.test(raw.slice(0, match.index! + 1)),
    )
    .map((match) => match.index! + match[0].length);
  const start =
    passage.start === 0 ? 0 : boundaries.find((n) => n < raw.length / 3) || 0;
  const end =
    passage.end === text.length
      ? raw.length
      : boundaries.filter((n) => n > (raw.length * 2) / 3).at(-1) || raw.length;
  const clipped = raw.slice(start, end);
  if (!passage.matchedTerms.every((term) => clipped.toLowerCase().includes(term)))
    return passage;
  return {
    ...passage,
    start: passage.start + start,
    end: passage.start + end,
    text: clipped.replace(/\s+/g, " ").trim(),
  };
}

export function scanTermHits(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  const unique = [
    ...new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean)),
  ].slice(0, 30);
  return unique.map((term) => {
    const positions: number[] = [];
    let offset = 0;
    while (positions.length < 2000) {
      const found = lower.indexOf(term, offset);
      if (found < 0) break;
      offset = found + term.length;
      if (/^[a-z0-9]/i.test(term) && /[a-z0-9]/i.test(text[found - 1] || "")) continue;
      if (/[a-z0-9]$/i.test(term) && /[a-z0-9]/i.test(text[offset] || "")) continue;
      positions.push(found);
    }
    return { term, positions, countCapped: positions.length === 2000 };
  });
}

export function rankPassages(
  text: string,
  terms: string[],
  limit = 3,
  width = 700,
  excluded: Array<{ start: number; end: number }> = [],
  scannedHits = scanTermHits(text, terms),
): Passage[] {
  const size = Math.max(80, Math.min(1400, width));
  const hits = scannedHits;
  const starts = new Set(
    hits.flatMap((hit) =>
      hit.positions.map((position) => Math.max(0, position - Math.floor(size / 3))),
    ),
  );
  if (!hits.length && text.trim()) starts.add(0);
  const overlap = (
    a: { start: number; end: number },
    b: { start: number; end: number },
  ) =>
    Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) /
    Math.max(1, Math.min(a.end - a.start, b.end - b.start));
  const candidates: Passage[] = [];
  for (const start of starts) {
    const end = Math.min(text.length, start + size);
    if (excluded.some((span) => overlap({ start, end }, span) > 0.5)) continue;
    const matched = hits.filter((hit) => {
      let left = 0;
      let right = hit.positions.length;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (hit.positions[middle] < start) left = middle + 1;
        else right = middle;
      }
      return (
        left < hit.positions.length && hit.positions[left] + hit.term.length <= end
      );
    });
    if (hits.length && !matched.length) continue;
    let score =
      matched.reduce(
        (sum, hit) =>
          sum +
          (1 + Math.min(3, hit.term.split(/\s+/).length - 1)) /
            Math.sqrt(hit.positions.length || 1),
        0,
      ) +
      Math.max(0, matched.length - 1) * 0.5;
    // Dense numbered bibliography entries are weak execution evidence, not absent evidence.
    const excerpt = text.slice(start, end);
    if ((excerpt.match(/(?:^|\s)\d{1,3}\.\s+[A-Z][\p{L}'’-]+,/gu) || []).length >= 2)
      score *= 0.15;
    candidates.push({
      start,
      end,
      text: text.slice(start, end).replace(/\s+/g, " ").trim(),
      matchedTerms: matched.map((hit) => hit.term),
      score,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const selected: Passage[] = [];
  for (const rawCandidate of candidates) {
    const candidate = alignSentence(text, rawCandidate);
    if (selected.some((span) => overlap(candidate, span) > 0.5)) continue;
    selected.push(candidate);
    if (selected.length >= Math.max(1, limit)) break;
  }
  return selected;
}

export function adjacentPassage(
  text: string,
  span: { start: number; end: number },
  direction: "before" | "after",
  width = 700,
  excluded: Array<{ start: number; end: number }> = [],
): Passage[] {
  width = Math.max(80, Math.min(1400, width));
  let start = direction === "before" ? Math.max(0, span.start - width) : span.end;
  let end =
    direction === "before" ? span.start : Math.min(text.length, span.end + width);
  if (start < 0 || end > text.length || end <= start) return [];
  // Trim already read edges, including adjoining/overlapping intervals, without
  // jumping across an unread gap. Offsets remain those of the original cache.
  for (const seen of [...excluded].sort((a, b) =>
    direction === "after" ? a.start - b.start : b.end - a.end,
  )) {
    if (direction === "after" && seen.start <= start && seen.end > start)
      start = Math.min(end, seen.end);
    if (direction === "before" && seen.end >= end && seen.start < end)
      end = Math.max(start, seen.start);
  }
  if (end <= start) return [];
  if (
    excluded.some(
      (seen) =>
        Math.max(0, Math.min(end, seen.end) - Math.max(start, seen.start)) /
          Math.max(1, Math.min(end - start, seen.end - seen.start)) >
        0.5,
    )
  )
    return [];
  return [
    alignSentence(text, {
      start,
      end,
      text: text.slice(start, end).replace(/\s+/g, " ").trim(),
      matchedTerms: [],
      score: 0,
    }),
  ];
}
