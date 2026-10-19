/** Field matching only; spelling matches are not proof of a person's identity. */
export function authorEvidence(authors: string[], query: string) {
  const tokens = (value: string): string[] =>
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || [];
  const expected = tokens(query);
  const surname = tokens(query.includes(",") ? query.split(",")[0] : query).at(-1);
  const matches = authors.flatMap((name, index) => {
    const actual = tokens(name);
    const actualSurname = tokens(name.includes(",") ? name.split(",")[0] : name).at(-1);
    const match =
      expected.length > 0 &&
      Boolean(surname && surname.length > 1 && actualSurname === surname) &&
      expected.every((word) =>
        actual.some(
          (token) =>
            token === word ||
            (word !== surname &&
              Math.min(token.length, word.length) === 1 &&
              token[0] === word[0]),
        ),
      );
    return match ? [{ name, position: index + 1 }] : [];
  });
  return {
    authors: matches.map((match) => match.name),
    authorMatches: matches,
    authorCount: authors.length,
    authorQuery: query,
    authorSelection: "matched-only",
    fullAuthorFieldChecked: true,
    authorsTruncated: matches.length < authors.length,
  };
}
