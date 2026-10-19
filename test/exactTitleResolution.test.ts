import { afterEach, expect, it, vi } from "vitest";
import { ZoteroRetriever } from "../src/host/zoteroRetriever";
import { suppliedExactTitles } from "../src/retrieval/exactTitleResolution";
import { normalizeQuery } from "../src/retrieval/ranking";
import { ToolRegistry } from "../src/agent/toolRegistry";

afterEach(() => vi.unstubAllGlobals());
const titles = [
  "Adaptive trait dynamics in coastal systems",
  "Parallel trait origins in inland systems",
];
const query = (values = titles) =>
  normalizeQuery({ intent: "known_item", required: [["trait"]], exactTitles: values });

function setup() {
  const documents = titles.map((title, i) => ({
    item: { libraryID: 1, itemKey: `PAPER00${i + 1}` },
    title,
    abstract: "Adaptive trait evidence",
    authors: [],
    tags: [],
    year: 2024,
  }));
  const search = vi.fn(async (condition: string, term: string) =>
    condition === "title"
      ? titles.flatMap((title, i) => (title === term ? [i + 1] : []))
      : [1, 2],
  );
  vi.stubGlobal("Zotero", {
    Libraries: { userLibraryID: 1 },
    logError: vi.fn(),
    Search: class {
      libraryID = 1;
      field = "";
      term = "";
      addCondition(field: string, _operator: string, term?: string) {
        if (field !== "noChildren") {
          this.field = field;
          this.term = term || "";
        }
      }
      search() {
        return search(this.field, this.term);
      }
    },
    Items: {
      getAsync: async (id: number) => ({
        id,
        key: documents[id - 1].item.itemKey,
        libraryID: 1,
        isRegularItem: () => true,
      }),
    },
  });
  const semantic = { searchPapers: vi.fn(async () => []) };
  const retriever = new ZoteroRetriever(semantic);
  vi.spyOn(retriever as any, "toDocument").mockImplementation(async (item: any) => ({
    ...documents[item.id - 1],
  }));
  return { retriever, semantic, search, documents };
}

it("uses only actual supplied titles and does not silently omit another quoted title", () => {
  expect(
    suppliedExactTitles(query(), `比较《${titles[0]}》和《${titles[1]}》`),
  ).toEqual(titles);
  expect(
    suppliedExactTitles(query([titles[0]]), `比较《${titles[0]}》和《${titles[1]}》`),
  ).toEqual([]);
  expect(suppliedExactTitles(query(), "Find the remembered trait study")).toEqual([]);
  expect(
    suppliedExactTitles({ ...query(), intent: "topic" }, `Find ${titles[0]}`),
  ).toEqual([]);
});

it("resolves all named papers without semantic/whole-library discovery and labels its limited scope", async () => {
  const { retriever, semantic, search } = setup();
  const broad = vi.spyOn(retriever as any, "recallRegularItems");
  const fulltext = vi.spyOn(retriever as any, "recallFulltextItems");
  const result = await retriever.searchLibrary(
    query(),
    `比较《${titles[0]}》和《${titles[1]}》`,
    { preferExactTitles: true },
  );
  expect(search).toHaveBeenCalledTimes(2);
  expect(result.items.map((item) => item.item.itemKey).sort()).toEqual([
    "PAPER001",
    "PAPER002",
  ]);
  expect(broad).not.toHaveBeenCalled();
  expect(fulltext).not.toHaveBeenCalled();
  expect(semantic.searchPapers).not.toHaveBeenCalled();
  expect(result.discovery).toMatchObject({
    exactTitleResolved: true,
    scope: "supplied-exact-titles",
    fulltextDeferred: true,
    semanticCandidates: 0,
  });
  expect(result.trace?.every((row) => row.semanticRank === undefined)).toBe(true);
});

it("opts into direct resolution through the registry only for a supplied complete title", async () => {
  const { retriever, semantic } = setup();
  const registry = new ToolRegistry(retriever);
  const result = await registry.execute(
    {
      id: "plan",
      name: "plan_search",
      arguments: {
        ...query([titles[0]]),
        englishQueries: ["adaptive trait"],
        searchCombinations: [
          "adaptive trait",
          "adaptive trait dynamics",
          "trait coastal systems",
        ],
        rationale: "Identify the current user-supplied complete title",
      },
    },
    {
      conversationID: "direct-title",
      userQuery: `Find 《${titles[0]}》`,
      context: { refs: { items: [], attachments: [] } } as any,
      evidenceBudget: { remainingChars: 60000 } as any,
      maxAttachments: 20,
    },
  );
  expect(result.ok).toBe(true);
  expect((result.content as any).discovery).toMatchObject({
    exactTitleResolved: true,
    scope: "supplied-exact-titles",
  });
  expect(result.summary).toContain("user-supplied exact-title");
  expect(semantic.searchPapers).not.toHaveBeenCalled();
});

it("falls back if one title is missing, a hard filter fails, or a field is unreadable", async () => {
  for (const variant of ["missing", "filtered", "unreadable"]) {
    const { retriever } = setup();
    const broad = vi
      .spyOn(retriever as any, "recallRegularItems")
      .mockResolvedValue({ ids: [], provenanceByID: new Map() });
    const fulltext = vi
      .spyOn(retriever as any, "recallFulltextItems")
      .mockResolvedValue({ ids: [], hitsByParentID: new Map() });
    if (variant === "unreadable")
      vi.spyOn(retriever as any, "toDocument").mockResolvedValue({
        ...setupDocument(),
        readWarnings: ["abstract"],
      });
    const q =
      variant === "missing"
        ? query([titles[0], "Missing exact article title"])
        : variant === "filtered"
          ? { ...query(), yearMin: 2025 }
          : query([titles[0]]);
    const request = `Compare ${q.exactTitles!.join(" and ")}`;
    const result = await retriever.searchLibrary(q, request, {
      preferExactTitles: true,
    });
    expect(broad).toHaveBeenCalledOnce();
    expect(fulltext).toHaveBeenCalledOnce();
    expect(result.discovery.exactTitleResolved).toBeUndefined();
  }
});

it("explicit expansion and fuzzy requests retain the original broad discovery path", async () => {
  const { retriever, semantic } = setup();
  const broad = vi
    .spyOn(retriever as any, "recallRegularItems")
    .mockResolvedValue({ ids: [], provenanceByID: new Map() });
  vi.spyOn(retriever as any, "recallFulltextItems").mockResolvedValue({
    ids: [],
    hitsByParentID: new Map(),
  });
  await retriever.searchLibrary(query([titles[0]]), titles[0], {
    preferExactTitles: true,
  });
  expect(broad).not.toHaveBeenCalled();
  await retriever.searchLibrary(query([titles[0]]), titles[0]);
  expect(broad).toHaveBeenCalledOnce();
  expect(semantic.searchPapers).toHaveBeenCalled();
  retriever.resetEvidenceSession();
  await retriever.searchLibrary(
    { ...query([]), intent: "remembered_item" },
    "Find a study about repeated trait origins",
    { preferExactTitles: true, deferFulltext: true },
  );
  expect(broad).toHaveBeenCalledTimes(2);
});

it("caches metadata buckets across revised plans without changing bucket order or provenance", async () => {
  const { retriever, search } = setup();
  const recall = (terms: string[]) =>
    (retriever as any).recallRegularItems(1, normalizeQuery({ required: [terms] }));
  const first = await recall(["adaptive"]);
  expect(search).toHaveBeenCalledTimes(3);
  const repeat = await recall(["adaptive"]);
  expect(repeat).toEqual(first);
  expect(search).toHaveBeenCalledTimes(3);
  await recall(["adaptive", "coastal"]);
  expect(search).toHaveBeenCalledTimes(6);
  retriever.resetEvidenceSession();
  await recall(["adaptive"]);
  expect(search).toHaveBeenCalledTimes(9);
});

const setupDocument = () => ({
  item: { libraryID: 1, itemKey: "PAPER001" },
  title: titles[0],
  abstract: "Trait evidence",
  authors: [],
  tags: [],
  year: 2024,
});
