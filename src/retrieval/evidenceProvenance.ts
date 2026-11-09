import type { PassageProvenance } from "../core/types";

export function classifyPassage(
  text: string,
  start: number,
  end: number,
): PassageProvenance {
  // Section labels are extraction heuristics, not proof of a claim. Explicit
  // post-reference boundaries must end a bibliography, even for unknown sections.
  const prefix = text.slice(0, end);
  const boundaries: Array<{ index: number; section: PassageProvenance["section"] }> =
    [];
  for (const match of prefix.matchAll(
    /(?:^|\n)[\t ]*(?:(?:\d+(?:\.\d+)*[.)]?|[IVX]+\.)[\t ]+)?((?:(?:supplementary|supplemental)[\t ]+)?(?:materials[\t ]+and[\t ]+methods|methods|experimental[\t ]+procedures)|results(?:[\t ]+and[\t ]+discussion)?|discussion|references(?:[\t ]+and[\t ]+notes)?|bibliography|reporting[\t ]+summary|data[\t ]+availability|code[\t ]+availability|acknowledg(?:e)?ments|author[\t ]+contributions|competing[\t ]+interests|additional[\t ]+information|supplementary[\t ]+information|software[\t ]+and[\t ]+code|参考文献|材料与方法|研究方法|结果|讨论|致谢|补充材料)[\t ]*[:：]?[\t ]*\r?(?=\n|$)/gimu,
  )) {
    const label = match[1].toLowerCase();
    boundaries.push({
      index: match.index!,
      section: /references|bibliography|参考文献/u.test(label)
        ? "references"
        : /methods|procedures|方法/u.test(label)
          ? "methods"
          : /results|结果/u.test(label)
            ? "results"
            : /discussion|讨论/u.test(label)
              ? "discussion"
              : "unknown",
    });
  }
  // Captions can start on the same line as their title and continue for many lines.
  for (const match of prefix.matchAll(
    /(?:^|\n)[\t ]*((?:(?:extended[\t ]+data|supplementary|supplemental)[\t ]+)?(?:fig(?:ure)?s?\.?|tables?))[\t ]*S?\d+[a-z]?[\t ]*(?:[|.:：–—]|(?=\n|$))/gimu,
  )) {
    boundaries.push({
      index: match.index!,
      section: /fig/iu.test(match[1]) ? "figure-legend" : "unknown",
    });
  }
  const heading = boundaries.sort((a, b) => a.index - b.index).at(-1);
  if (heading?.section === "figure-legend" && heading.index <= start) {
    const between = text.slice(heading.index, start);
    // PDF text often loses subheading styles. Do not let a caption label bleed
    // into a later short heading or indefinitely into the surrounding article.
    const lines = between.split(/\r?\n/u).slice(1);
    const possibleHeading = lines.some((line) => {
      const value = line.trim();
      return (
        /^[A-Z][^.!?。！？:：|]{3,100}$/u.test(value) &&
        value.split(/\s+/u).length <= 14
      );
    });
    if (possibleHeading || between.length > 2000)
      return { section: "unknown", basis: "unknown", confidence: "low" };
  }
  if (heading && heading.index <= start)
    return {
      section: heading.section,
      basis: "heading",
      confidence: heading.section === "unknown" ? "low" : "high",
    };
  const excerpt = text.slice(start, end);
  if ((excerpt.match(/(?:^|\s)\d{1,3}\.\s+[A-Z][\p{L}'’-]+,/gu) || []).length >= 2)
    return {
      section: "references",
      basis: "bibliographic-pattern",
      confidence: "medium",
    };
  if (/^\s*(?:fig(?:ure)?\.?\s*\d+|图\s*\d+)\s*[.:：]/iu.test(excerpt))
    return { section: "figure-legend", basis: "text-pattern", confidence: "low" };
  return { section: "unknown", basis: "unknown", confidence: "low" };
}

export function indexCompleteness(state: string): string {
  return state === "3"
    ? "indexed"
    : state === "2"
      ? "partial"
      : state === "0" || state === "1"
        ? "not-fully-indexed"
        : "unknown";
}
