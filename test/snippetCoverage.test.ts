import { afterEach, expect, it, vi } from "vitest";
import { ZoteroRetriever } from "../src/host/zoteroRetriever";
import { ToolRegistry } from "../src/agent/toolRegistry";
import { scanTermHits } from "../src/retrieval/passageReader";

afterEach(() => vi.unstubAllGlobals());
const attachment = { libraryID: 1, itemKey: "FILE0001" };
function cacheFixture(text: string, indexState = 3) {
  vi.stubGlobal("Zotero", {
    ItemTypes: { getName: () => "attachment" },
    Items: {
      getByLibraryAndKey: () => ({
        libraryID: 1,
        key: attachment.itemKey,
        isAttachment: () => true,
      }),
    },
    Fulltext: {
      getItemCacheFile: () => ({ path: "synthetic-cache" }),
      getIndexedState: async () => indexState,
    },
    File: { getContentsAsync: async () => text },
  });
  vi.stubGlobal("IOUtils", { exists: async () => true });
  return new ZoteroRetriever();
}
it("reports zero raw matches separately from previously delivered passages", async () => {
  const retriever = cacheFixture(
    "Methods\nWe used Toolkit for inference.\n" + "x ".repeat(200),
  );
  const first = await retriever.readSnippets(
    [attachment],
    ["Toolkit", "unmatched"],
    1,
    1,
    120,
  );
  expect(first[0].provenance?.section).toBe("methods");
  expect(retriever.getSnippetCoverage()[0]).toMatchObject({
    indexCompleteness: "indexed",
    outcome: "passages-returned",
    termHits: [
      { term: "toolkit", count: 1, returnedInPassages: true },
      { term: "unmatched", count: 0, returnedInPassages: false },
    ],
  });
  const next = await retriever.readSnippets([attachment], ["Toolkit"], 1, 1, 120, {
    exclude: [{ attachment, ...first[0].position! }],
  });
  expect(next).toEqual([]);
  expect(retriever.getSnippetCoverage()[0]).toMatchObject({
    outcome: "already-delivered",
    termHits: [{ count: 1, returnedInPassages: false }],
  });
  await retriever.readSnippets([attachment], ["unknown"], 1, 1, 120);
  expect(retriever.getSnippetCoverage()[0]).toMatchObject({
    outcome: "no-term-match-in-scanned-cache",
    termHits: [{ count: 0 }],
  });
});
it("keeps counts before top-window selection and marks capped literal counts", async () => {
  const retriever = cacheFixture("alpha result " + "x ".repeat(150) + "beta result", 2);
  await retriever.readSnippets([attachment], ["alpha", "beta"], 1, 1, 100);
  const row: any = retriever.getSnippetCoverage()[0];
  expect(row.indexCompleteness).toBe("partial");
  expect(row.termHits.map((hit: any) => hit.count)).toEqual([1, 1]);
  expect(row.termHits.filter((hit: any) => hit.returnedInPassages)).toHaveLength(1);
  expect(scanTermHits("alpha ".repeat(2100), ["alpha"])[0]).toMatchObject({
    countCapped: true,
  });
  expect(scanTermHits("alphabets", ["alpha"])[0].positions).toEqual([]);
});
it("does not confuse a cache cap or missing cache with whole-document absence", async () => {
  const retriever = cacheFixture("x".repeat(2_000_001) + "faraway");
  await retriever.readSnippets([attachment], ["faraway"], 1, 1, 100);
  expect(retriever.getSnippetCoverage()[0]).toMatchObject({
    truncated: true,
    scannedChars: 2_000_000,
    termHits: [{ count: 0 }],
  });
  vi.stubGlobal("IOUtils", { exists: async () => false });
  retriever.resetEvidenceSession();
  await retriever.readSnippets([attachment], ["faraway"], 1, 1, 100);
  expect(retriever.getSnippetCoverage()[0]).toMatchObject({ state: "cache-missing" });
});
it("reports returned versus budget-delivered passages and provides soft review checkpoints", async () => {
  const readSnippets = vi.fn(async () => [
    {
      sourceID: "src-a",
      item: { libraryID: 1, itemKey: "PAPER001" },
      attachment,
      text: "We used Toolkit for inference.",
      field: "fulltext",
      score: 1,
      matchedTerms: ["toolkit"],
    },
  ]);
  const registry = new ToolRegistry({
    readSnippets,
    getSnippetCoverage: () => [
      {
        attachment,
        returned: 1,
        termHits: [{ term: "toolkit", count: 1, returnedInPassages: true }],
      },
    ],
  } as any);
  const context: any = {
    userQuery: "分析方法流程是什么？",
    maxAttachments: 8,
    context: { refs: { items: [], attachments: [attachment] } },
    evidenceBudget: { remainingChars: 0 },
  };
  const read = (extra = {}) =>
    registry.execute(
      {
        id: "r",
        name: "read_attachment_snippets",
        arguments: { attachments: [attachment], terms: ["Toolkit"], ...extra },
      },
      context,
    );
  const empty = await read({ verificationTargets: ["Analysis object", "Parameters"] });
  expect((empty.content as any).coverage[0]).toMatchObject({
    deliveredToModel: 0,
    budgetExcludedPassages: 1,
    termHits: [{ count: 1, deliveredToModel: false }],
  });
  context.evidenceBudget.remainingChars = 60000;
  await read();
  const third = await read();
  expect((third.content as any).reviewCheckpoint).toMatchObject({
    readBatches: 3,
    verificationTargets: ["Analysis object", "Parameters"],
    existingEvidence: [{ sourceID: "src-a" }],
  });
  const fourth = await read();
  expect(fourth.ok).toBe(true);
  registry.clearSources();
  const reset = await read();
  expect((reset.content as any).reviewCheckpoint).toMatchObject({
    readBatches: 1,
    verificationTargets: [],
  });
});
