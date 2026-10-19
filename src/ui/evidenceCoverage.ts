import type { SourceReference } from "../core/types";
import { createMenuTranslator } from "./menuLocale";

export function evidenceCoverage(
  source: SourceReference,
  t = createMenuTranslator("zh-CN"),
): string | undefined {
  if (source.field !== "fulltext" || !source.coverage) return undefined;
  const status =
    source.indexState === "2"
      ? t("Zotero partial index (not the complete PDF)")
      : source.indexState === "3"
        ? t("Zotero marks this as indexed")
        : t("Zotero index completeness unknown");
  const { scannedChars, cacheChars, truncated } = source.coverage;
  return t(
    "{status}; locally scanned {scanned}/{cache} cache characters ({truncation}). The model received selected passages only, not the complete PDF.",
    {
      status,
      scanned: scannedChars,
      cache: cacheChars,
      truncation: t(truncated ? "scan truncated" : "cache scan not truncated"),
    },
  );
}
