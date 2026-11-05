import { SourceReference } from "../core/types";

export function resolveCitationID(id: string, sources: SourceReference[]) {
  const exact = sources.find((source) => source.sourceID === id);
  const matches = exact
    ? [exact]
    : /^src-[a-zA-Z0-9_-]{8,}$/.test(id)
      ? sources.filter((source) => source.sourceID.startsWith(id))
      : [];
  return {
    sourceID: matches.length === 1 ? matches[0].sourceID : undefined,
    error: matches.length > 1 ? "ambiguous-source-id" : "unknown-source-id",
  };
}

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
    const match = resolveCitationID(id, sources);
    if (match.sourceID) resolved.set(id, match.sourceID);
    else invalid.push(id);
  }
  return {
    answer: answer.replace(/src-[a-zA-Z0-9_-]+/gu, (id) => resolved.get(id) || id),
    sourceIDs: [...new Set(resolved.values())],
    invalid,
  };
}
