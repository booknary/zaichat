// Model-proposed noise terms cannot become hard filters without literal user
// authorization. Uncertain/translated exclusions stay non-binding.
export function authorizedExclusions(terms: string[], userQuery: string): string[] {
  return terms.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?:排除|不包含|不包括|不含|不要|不是|exclude|excluding|without|not about)\\s*["'“]?${escaped}(?=$|[\\s,，。;；"'”])`,
      "iu",
    ).test(userQuery);
  });
}
