import { expect, it } from "vitest";
import { evidenceCoverage } from "../src/ui/evidenceCoverage";
import type { SourceReference } from "../src/core/types";

it("distinguishes partial indexing from scanning the entire cache", () => {
  const source: SourceReference = {
    sourceID: "test",
    item: { libraryID: 1, itemKey: "TEST" },
    label: "Paper",
    field: "fulltext",
    indexState: "2",
    coverage: { cacheChars: 1000, scannedChars: 1000, truncated: false },
  };
  expect(evidenceCoverage(source)).toContain("部分索引");
  expect(evidenceCoverage(source)).toContain("缓存扫描未截断");
  expect(evidenceCoverage(source)).toContain("不代表已阅读完整 PDF");
  expect(
    evidenceCoverage({
      ...source,
      indexState: "unknown",
      coverage: { cacheChars: 2000, scannedChars: 1000, truncated: true },
    }),
  ).toContain("扫描已截断");
  expect(evidenceCoverage({ ...source, field: "title" })).toBeUndefined();
  expect(evidenceCoverage({ ...source, coverage: undefined })).toBeUndefined();
});
