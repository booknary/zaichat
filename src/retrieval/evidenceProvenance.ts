import type { PassageProvenance } from "../core/types";

export function classifyPassage(
  text: string,
  start: number,
  end: number,
): PassageProvenance {
  // Heuristics, not PDF structure parsing. Only explicit section headings carry
  // high confidence; an undetected section remains unknown, not "methods".
  const headings = [
    ...text
      .slice(0, end)
      .matchAll(
        /(?:^|\n)\s*(?:(?:\d+(?:\.\d+)*[.)]?|[IVX]+\.)\s+)?(materials\s+and\s+methods|methods|experimental\s+procedures|results(?:\s+and\s+discussion)?|discussion|references(?:\s+and\s+notes)?|bibliography|参考文献|材料与方法|研究方法|结果|讨论)\s*[:：]?\s*(?=\n|$)/gimu,
      ),
  ];
  const heading = headings.at(-1);
  if (heading && heading.index! <= start) {
    const label = heading[1].toLowerCase();
    return {
      section: /references|bibliography|参考文献/u.test(label)
        ? "references"
        : /methods|procedures|方法/u.test(label)
          ? "methods"
          : /results|结果/u.test(label)
            ? "results"
            : "discussion",
      basis: "heading",
      confidence: "high",
    };
  }
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
