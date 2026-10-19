import type { RetrievalQuery } from "../core/types";
import { normalizeText } from "./ranking";

/** Only titles present in this user's request can bypass broad discovery. */
export function suppliedExactTitles(
  query: RetrievalQuery,
  userQuery: string,
): string[] {
  if (query.intent === "topic" || query.intent === "synthesis") return [];
  const request = normalizeText(userQuery);
  const quoted = [...userQuery.matchAll(/《([^》]+)》|["“]([^"”]+)["”]/gu)].map(
    (match) => normalizeText(match[1] || match[2]),
  );
  const titles = [...new Set(query.exactTitles || [])]
    .filter((title) => {
      const normalized = normalizeText(title);
      return (
        normalized.length >= 12 &&
        request.includes(normalized) &&
        (!quoted.length || quoted.includes(normalized))
      );
    })
    .slice(0, 4);
  if (
    quoted.some(
      (title) =>
        title.length >= 12 &&
        !titles.some((candidate) => normalizeText(candidate) === title),
    )
  )
    return [];
  return titles;
}
