import { SourceReference } from "../core/types";

/** Only unique source-ID prefixes may be expanded; item keys are not citations. */
export function repairCitations(
  answer: string,
  requested: string[],
  sources: SourceReference[],
) {
  const ids = [
    ...new Set([...requested, ...(answer.match(/src-[a-zA-Z0-9_-]+/gu) || [])]),
  ];
  const resolved = new Map<string, string>();
  const invalid: string[] = [];
  for (const id of ids) {
    const exact = sources.find((source) => source.sourceID === id);
    const matches = exact
      ? [exact]
      : /^src-[a-zA-Z0-9_-]{8,}$/.test(id)
        ? sources.filter((source) => source.sourceID.startsWith(id))
        : [];
    if (matches.length === 1) resolved.set(id, matches[0].sourceID);
    else invalid.push(id);
  }
  return {
    answer: answer.replace(/src-[a-zA-Z0-9_-]+/gu, (id) => resolved.get(id) || id),
    sourceIDs: [...new Set(resolved.values())],
    invalid,
  };
}
