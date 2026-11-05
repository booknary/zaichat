import { expect, it } from "vitest";
import { candidateAuthors, candidateExcerpt } from "../src/utils/candidatePreview";
import { ZoteroRetriever } from "../src/host/zoteroRetriever";
import { ToolRegistry } from "../src/agent/toolRegistry";
import { normalizeQuery } from "../src/retrieval/ranking";

it("selects late query-relevant text, preserving negation and original wording within all existing caps", () => {
  const text =
    "General introduction. ".repeat(30) +
    "We did not use optical calibration; instead we used thermal calibration." +
    " Further discussion.".repeat(30);
  for (const cap of [360, 240, 120]) {
    const excerpt = candidateExcerpt(
      text,
      ["optical calibration", "thermal calibration"],
      cap,
    );
    expect(excerpt).toContain("did not use optical calibration");
    expect(excerpt.length).toBeLessThanOrEqual(cap);
    expect(text).toContain(excerpt.replace(/^…|…$/gu, ""));
  }
  expect(candidateExcerpt(text, ["unmatched"], 120)).toMatch(/^General introduction/);
  const chinese =
    "研究背景。".repeat(70) +
    "本研究没有采用机械压缩，而是进行了热处理实验。" +
    "其他讨论。".repeat(40);
  expect(candidateExcerpt(chinese, ["机械压缩", "热处理"], 120)).toContain(
    "没有采用机械压缩",
  );
  expect(
    candidateExcerpt(text, ["[a-z]", "a+b", "(x)"], 120).length,
  ).toBeLessThanOrEqual(120);
});
it("carries complete author counts through repeated preview truncation and read failures", () => {
  const authors = Array.from({ length: 25 }, (_, i) => "Person " + i);
  const first = candidateAuthors({ authors }, 12);
  const second = candidateAuthors(first, 6);
  expect(candidateAuthors(second, 3)).toMatchObject({
    authorCount: 25,
    authorsTruncated: true,
  });
  expect(candidateAuthors(second, 3).authors).toHaveLength(3);
  expect(candidateAuthors({ authors: ["One", "Two"] }, 3).authorsTruncated).toBe(false);
  expect(candidateAuthors({ authors: [], readWarnings: ["authors"] }, 3)).toMatchObject(
    { authorCount: null, authorsTruncated: true },
  );
});
it("selects before the host's 360-character cut and retains candidate identity and score", () => {
  const retriever = new ZoteroRetriever();
  const item: any = {
    item: { libraryID: 1, itemKey: "SYNTH001" },
    title: "Synthetic study",
    authors: Array.from({ length: 25 }, (_, i) => "Person " + i),
    abstract:
      "Unrelated background. ".repeat(30) +
      "We tested thermal calibration using a controlled reference.",
    tags: [],
    score: 0.42,
    matchedFields: ["abstract"],
  };
  const before = structuredClone(item);
  const candidate = (retriever as any).toCandidate(item, undefined, "src-synthetic", [
    "thermal calibration",
  ]);
  expect(candidate.abstractExcerpt).toContain("thermal calibration");
  expect(candidate).toMatchObject({
    score: 0.42,
    authorCount: 25,
    authorsTruncated: true,
  });
  expect(item).toEqual(before);
});
it("preserves candidate order and spends the existing budget while presenting useful excerpts", () => {
  const registry = new ToolRegistry({} as any);
  (registry as any).activePlan = normalizeQuery({
    required: [["calibration"]],
    optional: [],
    excluded: [],
    limit: 50,
  });
  const items = Array.from({ length: 20 }, (_, i) => ({
    item: { libraryID: 1, itemKey: "ITEM" + i },
    title: "Synthetic " + i,
    authors: ["One", "Two", "Three", "Four"],
    authorCount: 15,
    authorsTruncated: true,
    abstractExcerpt:
      "Background. ".repeat(20) + "We tested calibration with a reference sensor.",
    score: 20 - i,
    attachmentRefs: [],
  }));
  const snapshot = structuredClone(items);
  const budget = {
    remainingChars: 60000,
    candidateRemainingChars: 36000,
    verificationReserveChars: 12000,
  };
  const response = (registry as any).budgetedCandidates(
    { id: "p", name: "next_search_results" },
    items,
    budget,
    8000,
    "Preview",
  );
  const delivered = response.content.items;
  expect(delivered.length).toBeGreaterThan(0);
  expect(delivered.map((x: any) => x.item.itemKey)).toEqual(
    items.slice(0, delivered.length).map((x) => x.item.itemKey),
  );
  for (const row of delivered) {
    expect(row.abstractExcerpt).toContain("calibration");
    expect(row.abstractExcerpt.length).toBeLessThanOrEqual(120);
    expect(row.authorCount).toBe(15);
    expect(row.authorsTruncated).toBe(true);
  }
  expect(budget.remainingChars).toBe(60000 - response.evidenceCharsUsed);
  expect(budget.candidateRemainingChars).toBe(36000 - response.evidenceCharsUsed);
  expect(budget.verificationReserveChars).toBe(12000);
  expect(items).toEqual(snapshot);
});
