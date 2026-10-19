import { afterEach, expect, it, vi } from "vitest";
import { ZoteroRetriever } from "../src/host/zoteroRetriever";
import { ToolRegistry } from "../src/agent/toolRegistry";
import {
  createTextMatcher,
  normalizeQuery,
  scoreDocument,
  termMatchRatio,
} from "../src/retrieval/ranking";

afterEach(() => vi.unstubAllGlobals());
const ref = { libraryID: 1, itemKey: "PAPER001" };
const extra = { libraryID: 1, itemKey: "PAPER002" };
const plan = {
  intent: "known_item",
  required: [["adaptive trait"]],
  optional: [],
  excluded: [],
  englishQueries: ["adaptive trait"],
  searchCombinations: [
    "adaptive trait",
    "adaptive trait evolution",
    "adaptive trait origin",
  ],
  rationale: "Resolve a paper from its remembered trait",
};
const context = () => ({
  conversationID: "test",
  userQuery: "Find the adaptive trait paper",
  maxAttachments: 20,
  context: { refs: { items: [], attachments: [] } },
  evidenceBudget: { remainingChars: 60000 },
});
function candidate(item = ref) {
  return {
    item,
    sourceID: `src-${item.itemKey}`,
    title: "Synthetic adaptive trait study",
    authors: [],
    tags: [],
    attachmentRefs: [],
    publicationTitle: "Synthetic journal",
    date: "2024",
    doi: "10.0000/test",
  };
}
const source = (item = ref) => ({
  item,
  sourceID: `src-${item.itemKey}`,
  label: "Synthetic adaptive trait study",
});

it("defers fulltext for identification, expands without losing old sources, and counts one pool consistently", async () => {
  const searchLibrary = vi.fn(async (_query, _user, options) => ({
    items: options?.deferFulltext ? [candidate()] : [candidate(), candidate(extra)],
    sources: [source(), source(extra)],
    discovery: { fulltextDeferred: Boolean(options?.deferFulltext) },
  }));
  const registry = new ToolRegistry({ searchLibrary } as any);
  const ctx: any = context();
  const first = await registry.execute(
    { id: "p", name: "plan_search", arguments: plan },
    ctx,
  );
  expect(first.ok).toBe(true);
  expect((first.content as any).coverage.fulltextDeferred).toBe(true);
  expect((first.content as any).items[0].publicationTitle).toBe("Synthetic journal");
  expect((first.content as any).totalAvailable).toBe(1);
  const premature = await registry.execute(
    {
      id: "f",
      name: "finish_answer",
      arguments: { answer: "No match", evidenceInsufficient: true, sourceIDs: [] },
    },
    ctx,
  );
  expect(premature.ok).toBe(false);
  expect(JSON.stringify(premature)).toContain("expand_search");
  (registry as any).exactTitlesResolved = true;
  const expanded = await registry.execute(
    { id: "e", name: "expand_search", arguments: {} },
    ctx,
  );
  expect(expanded.ok).toBe(true);
  expect((registry as any).exactTitlesResolved).toBe(false);
  expect((expanded.content as any).items.map((item: any) => item.item)).toEqual([
    extra,
  ]);
  expect((expanded.content as any).coverage).toMatchObject({
    candidatePoolTotal: 2,
    reviewedInCurrentPool: 2,
    remainingCandidates: 0,
    fulltextDeferred: false,
  });
  expect((expanded.content as any).pageDelivered).toBe(1);
  expect((expanded.content as any).totalAvailable).toBe(2);
  expect(registry.resolveSources([source().sourceID])).toHaveLength(1);
  await registry.execute({ id: "e2", name: "expand_search", arguments: {} }, ctx);
  expect(searchLibrary).toHaveBeenCalledTimes(2);
});

it("runs deferred fulltext later and reuses metadata/semantic recall only until session reset", async () => {
  const docs = [ref, extra].map((item) => ({
    item,
    title: "Adaptive trait",
    abstract: "Trait evolution",
    authors: [],
    tags: [],
  }));
  vi.stubGlobal("Zotero", {
    Libraries: { userLibraryID: 1 },
    Items: {
      getAsync: async (id: number) => ({
        id,
        key: docs[id - 1].item.itemKey,
        libraryID: 1,
        isRegularItem: () => true,
      }),
      getByLibraryAndKey: () => ({ id: 1 }),
    },
  });
  const semantic = { searchPapers: vi.fn(async () => []) };
  const retriever = new ZoteroRetriever(semantic);
  const metadata = vi
    .spyOn(retriever as any, "recallRegularItems")
    .mockResolvedValue({ ids: [1], provenanceByID: new Map() });
  const fulltext = vi
    .spyOn(retriever as any, "recallFulltextItems")
    .mockResolvedValue({ ids: [2], hitsByParentID: new Map() });
  vi.spyOn(retriever as any, "toDocument").mockImplementation(
    async (item: any) => docs[item.id - 1],
  );
  const query = normalizeQuery(plan);
  const initial = await retriever.searchLibrary(query, "adaptive trait", {
    deferFulltext: true,
  });
  expect(initial.discovery.fulltextRoutes).toBe(0);
  expect(fulltext).not.toHaveBeenCalled();
  const semanticCalls = semantic.searchPapers.mock.calls.length;
  const expanded = await retriever.searchLibrary(query, "adaptive trait");
  expect(expanded.items.some((item) => item.item.itemKey === extra.itemKey)).toBe(true);
  expect(fulltext).toHaveBeenCalledOnce();
  expect(metadata).toHaveBeenCalledOnce();
  expect(semantic.searchPapers).toHaveBeenCalledTimes(semanticCalls);
  retriever.resetEvidenceSession();
  await retriever.searchLibrary(query, "adaptive trait");
  expect(metadata).toHaveBeenCalledTimes(2);
});

it("overlaps independent semantic work with host recall while preserving deterministic results", async () => {
  let releaseMetadata: (() => void) | undefined;
  let semanticStarted = false;
  let releaseObserved = false;
  vi.stubGlobal("Zotero", {
    Libraries: { userLibraryID: 1 },
    Items: {
      getByLibraryAndKey: () => ({ id: 1 }),
      getAsync: async () => ({
        id: 1,
        libraryID: 1,
        key: ref.itemKey,
        isRegularItem: () => true,
      }),
    },
  });
  const retriever = new ZoteroRetriever({
    searchPapers: async () => {
      semanticStarted = true;
      releaseObserved = Boolean(releaseMetadata);
      releaseMetadata?.();
      return [
        { libraryID: 1, itemKey: ref.itemKey, score: 0.9, sourceFields: ["abstract"] },
      ];
    },
  });
  vi.spyOn(retriever as any, "recallExactTitles").mockResolvedValue([]);
  vi.spyOn(retriever as any, "recallRegularItems").mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      releaseMetadata = resolve;
      setTimeout(resolve, 200);
    });
    return { ids: [1], provenanceByID: new Map() };
  });
  vi.spyOn(retriever as any, "toDocument").mockResolvedValue({
    item: ref,
    title: "Adaptive trait",
    abstract: "Trait evolution",
    authors: [],
    tags: [],
  });
  const result = await retriever.searchLibrary(normalizeQuery(plan), "adaptive trait", {
    deferFulltext: true,
  });
  expect(semanticStarted).toBe(true);
  expect(releaseObserved).toBe(true);
  expect(result.items.map((item) => item.item.itemKey)).toEqual([ref.itemKey]);
  expect(
    result.routeTrace?.every((route) => route.hits[0].itemKey === ref.itemKey),
  ).toBe(true);
  expect(result.discovery.timingsMs).toMatchObject({ fulltextRecall: 0 });
});

it("automatically inventories cached supplements for analysis verification and retains unread-format status", async () => {
  const main = { libraryID: 1, itemKey: "MAIN0001" };
  const si = { libraryID: 1, itemKey: "SUPP0001" };
  const readSnippets = vi.fn(async () => []);
  const listAttachments = vi.fn(async () => ({
    items: [
      { attachment: main, state: "cache-available-not-read" },
      { attachment: si, state: "cache-available-not-read" },
      {
        attachment: { libraryID: 1, itemKey: "TABLE001" },
        state: "unsupported-format",
      },
    ],
    totalAvailable: 3,
    offset: 0,
    nextOffset: null,
  }));
  const registry = new ToolRegistry({
    getItems: async () => ({
      items: [{ ...candidate(), attachmentRefs: [main] }],
      sources: [source()],
    }),
    listAttachments,
    readSnippets,
  } as any);
  const ctx: any = {
    ...context(),
    userQuery: "这篇文章有没有进行该分析",
    context: { refs: { items: [ref], attachments: [] } },
  };
  const current = await registry.execute(
    { id: "c", name: "get_current_context", arguments: {} },
    ctx,
  );
  expect((current.content as any).attachmentInventory[0].totalAvailable).toBe(3);
  const verified = await registry.execute(
    {
      id: "v",
      name: "verify_candidates",
      arguments: { sourceIDs: [source().sourceID], terms: ["analysis"] },
    },
    ctx,
  );
  expect(verified.ok).toBe(true);
  expect(readSnippets.mock.calls[0][0]).toEqual([main, si]);
  expect(listAttachments).toHaveBeenCalledOnce();
  expect((current.content as any).attachmentInventory[0].items[2].state).toBe(
    "unsupported-format",
  );
  expect((verified.content as any).attachmentInventory[0]).toMatchObject({
    reused: true,
    totalAvailable: 3,
  });
  expect((verified.content as any).attachmentInventory[0].items).toBeUndefined();
});

it("preserves multilingual/stemming scores while reusing tokenization", () => {
  const match = createTextMatcher();
  for (const text of [
    "Repeated evolution of flowering plants",
    "两次创新—遗传变化",
    "",
    "Genomic novelties in plants",
    "A long abstract. ".repeat(300),
  ])
    for (const term of [
      "evolution plants",
      "两次创新",
      "genomic novelty",
      "",
      "abstract long",
    ])
      expect(match(text, term)).toBe(termMatchRatio(text, term));
  const query = normalizeQuery({
    required: [["evolution", "evolving"], ["trait"]],
    optional: [["plants"]],
    englishQueries: ["evolutionary trait changes"],
  });
  const docs = Array.from({ length: 80 }, (_, i) => ({
    item: { libraryID: 1, itemKey: `TEST${i}` },
    title: `Trait evolution ${i}`,
    abstract: "Plants show repeated evolutionary changes in adaptive traits. ".repeat(
      70,
    ),
    authors: [],
    tags: ["traits"],
  }));
  const start = performance.now();
  const baseline = docs.map((doc) => scoreDocument(doc, query));
  const baselineMs = performance.now() - start;
  const cachedStart = performance.now();
  const optimized = docs.map((doc) => scoreDocument(doc, query, match));
  const cachedMs = performance.now() - cachedStart;
  expect(optimized).toEqual(baseline);
  console.info(
    `Synthetic scoring benchmark: baseline=${baselineMs.toFixed(1)}ms cached=${cachedMs.toFixed(1)}ms; 80 papers, identical scores`,
  );
});
