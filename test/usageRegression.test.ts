import { afterEach, describe, expect, it, vi } from "vitest";
import { ZoteroRetriever, fuseHybridResults } from "../src/host/zoteroRetriever";
import { normalizeQuery } from "../src/retrieval/ranking";
import { ToolRegistry } from "../src/agent/toolRegistry";
import {
  initialAgentState,
  toolsForAgentState,
  transitionAfterTool,
} from "../src/agent/agentState";
import { retrievalStrategyPrompt } from "../src/agent/retrievalStrategyPrompt";
import { AgentRunner } from "../src/agent/agentRunner";
import { authorizedExclusions } from "../src/retrieval/userConstraints";
import { recallTerms } from "../src/retrieval/ranking";
import { semanticQueryTexts } from "../src/host/zoteroRetriever";

afterEach(() => vi.unstubAllGlobals());

function library() {
  const annotation = {
    id: 3,
    key: "ANNOT001",
    libraryID: 1,
    itemType: "annotation",
    annotationText: "Method Alpha was used",
    annotationComment: "Methods",
  };
  const attachment = {
    id: 2,
    key: "PDF00001",
    libraryID: 1,
    itemType: "attachment",
    parentItemID: 1,
    getAnnotations: () => [annotation],
    getField: () => "PDF",
  };
  const paper = {
    id: 1,
    key: "PAPER001",
    libraryID: 1,
    itemType: "journalArticle",
    getField: (field: string) =>
      ({
        title: "A study of stellar spectra",
        abstractNote: "A comparative study",
        date: "2024",
      })[field] || "",
    getCreators: () => [],
    getTags: () => [],
    getNotes: () => [],
    getAttachments: () => [2],
    getCollections: () => [],
  };
  const items = [paper, attachment, annotation];
  const getAsync = vi.fn(async (id: number) => {
    if (!Number.isInteger(id)) throw new Error("invalid item identifier");
    return items.find((item) => item.id === id);
  });
  vi.stubGlobal("Zotero", {
    Items: {
      getAsync,
      get: (id: number) => items.find((item) => item.id === id),
      getByLibraryAndKey: (lib: number, key: string) =>
        items.find((item) => item.libraryID === lib && item.key === key),
    },
    Libraries: { userLibraryID: 1 },
    ItemTypes: { getName: () => "journalArticle" },
    Collections: { get: () => undefined },
    logError: vi.fn(),
  });
  return { paper, attachment, getAsync };
}

describe("cross-scenario usage regressions", () => {
  it("keeps local rank traces out of provider evidence and tracks budget losses", async () => {
    const items = Array.from({ length: 18 }, (_, index) => ({
      item: { libraryID: 1, itemKey: `TEST${index}` },
      sourceID: `source-${index}`,
      title: `Independent paper ${index}`,
      abstractExcerpt: "Scientific evidence. ".repeat(20),
      authors: ["Example Author"],
      tags: ["science"],
      attachmentRefs: [],
      matchedFields: ["title"],
      score: 1,
    }));
    const found = {
      items,
      sources: items.map((item) => ({
        sourceID: item.sourceID,
        item: item.item,
        label: item.title,
      })),
      trace: items.map((item, index) => ({
        ...item.item,
        semanticRank: index + 1,
        fusedRank: index + 1,
        stage: "selected",
      })),
      routeTrace: [{ routeIndex: 0, hits: [] }],
    };
    const registry = new ToolRegistry({
      searchLibrary: vi.fn(async () => found),
    } as any);
    const result = await registry.execute(
      {
        id: "search",
        name: "plan_search",
        arguments: {
          required: [["science"]],
          englishQueries: ["science methods"],
          searchCombinations: [
            "science methods",
            "scientific analysis",
            "research methods",
          ],
          excluded: ["assembly"],
        },
      },
      {
        conversationID: "c",
        userQuery: "find science",
        context: {
          refs: {
            items: [],
            attachments: [],
            notes: [],
            annotations: [],
            collections: [],
          },
        },
        evidenceBudget: { remainingChars: 1400 },
        maxAttachments: 20,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.retrievalTrace?.filter((entry) => entry.delivered)).toHaveLength(
      result.resultCount!,
    );
    expect(
      result.retrievalTrace?.some((entry) => entry.stage === "evidence-budget"),
    ).toBe(true);
    expect((result.content as any).retrievalTrace).toBeUndefined();
    expect((result.content as any).retrievalRouteTrace).toBeUndefined();
    expect((result.content as any).evidenceDetail).toBe("compact-preview");
    expect((result.content as any).ignoredExclusions).toEqual(["assembly"]);
    expect((result.content as any).plan.excluded).toEqual([]);
    expect(registry.resolveSources(["source-17"])).toEqual([]);
  });
  it.each(["listNotes", "listAnnotations"] as const)(
    "retains paper identity when %s fails",
    async (method) => {
      library();
      const retriever = new ZoteroRetriever();
      vi.spyOn(retriever, method).mockRejectedValue(
        new Error("Synthetic optional-field failure"),
      );
      const found = await retriever.getItems([{ libraryID: 1, itemKey: "PAPER001" }]);
      expect(found.items).toHaveLength(1);
      expect(found.items[0].title).toBe("A study of stellar spectra");
      expect(found.items[0].readWarnings).toContain(
        method === "listNotes" ? "notes" : "annotations",
      );
      expect(found.sources[0].sourceID).toBe(found.items[0].sourceID);
    },
  );

  it("never promotes speculative exclusions to hard filters", () => {
    expect(
      authorizedExclusions(["assembly", "business"], "Find papers about two changes"),
    ).toEqual([]);
    expect(
      authorizedExclusions(["reviews", "assembly"], "Find papers, exclude reviews"),
    ).toEqual(["reviews"]);
    expect(authorizedExclusions(["综述", "组装"], "找论文，不要综述")).toEqual([
      "综述",
    ]);
    expect(authorizedExclusions(["a+b"], "exclude a+b")).toEqual(["a+b"]);
    expect(authorizedExclusions(["review"], "exclude reviews")).toEqual([]);
  });

  it.each(["stellar brightening", "trade disruption", "immune tolerance"])(
    "executes uncertain synonyms without promoting associated mechanisms: %s",
    (term) => {
      const query = normalizeQuery({
        intent: "remembered_item",
        concepts: [
          {
            label: "phenomenon",
            meaning: "Remembered event",
            role: "required",
            variants: [
              { term: "literal event", relation: "canonical", confidence: "high" },
              { term, relation: "exact_synonym", confidence: "low" },
              {
                term: "speculative mechanism",
                relation: "related_term",
                confidence: "low",
              },
            ],
          },
        ],
      });
      expect(recallTerms(query)).toContain(term);
      expect(recallTerms(query)).not.toContain("speculative mechanism");
      expect(recallTerms(query).length).toBeLessThanOrEqual(36);
    },
  );

  it("reserves independent query families when composed synonyms saturate the route cap", () => {
    const query = normalizeQuery({
      intent: "remembered_item",
      concepts: ["alpha", "beta", "gamma"].map((term) => ({
        label: term,
        meaning: `Meaning of ${term}`,
        role: "required",
        variants: Array.from({ length: 8 }, (_, index) => ({
          term: `${term} ${index}`,
          relation: index ? "exact_synonym" : "canonical",
          confidence: "high",
        })),
      })),
      titleHypotheses: Array.from(
        { length: 8 },
        (_, i) => `alpha 0 beta 0 gamma 0 title ${i}`,
      ),
      englishQueries: ["alpha 0 beta 0 gamma 0 translation"],
      searchCombinations: ["alpha 0 beta 0 gamma 0 combination"],
    });
    const routes = semanticQueryTexts(query, "原始问题");
    expect(routes).toContain("原始问题");
    expect(routes).toContain(query.englishQueries![0]);
    expect(routes).toContain(query.searchCombinations![0]);
    expect(routes.some((route) => route.startsWith("Meaning of"))).toBe(true);
    expect(routes.length).toBeLessThanOrEqual(32);
    expect(new Set(routes).size).toBe(routes.length);
  });
  it("completes an attached-paper run without a forced whole-library search", async () => {
    library();
    const retriever = new ZoteroRetriever();
    const exposed: string[][] = [];
    let sourceID = "";
    let turn = 0;
    const provider = {
      complete: vi.fn(
        async (_profile: unknown, messages: any[], definitions: any[]) => {
          exposed.push(definitions.map((entry) => entry.function.name));
          const lastTool = [...messages]
            .reverse()
            .find((message) => message.role === "tool");
          if (lastTool) sourceID = JSON.parse(lastTool.content).items[0].sourceID;
          return {
            text: "",
            protocol: "native-tools",
            toolCalls: [
              turn++ === 0
                ? { id: "context", name: "get_current_context", arguments: {} }
                : {
                    id: "finish",
                    name: "finish_answer",
                    arguments: {
                      answer: "The attached title is A study of stellar spectra.",
                      sourceIDs: [sourceID],
                    },
                  },
            ],
          };
        },
      ),
    };
    const result = await new AgentRunner(
      provider as any,
      new ToolRegistry(retriever),
    ).run(
      "test",
      [
        {
          id: "u",
          role: "user",
          displayText: "What is this paper's title?",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      {
        refs: {
          items: [{ libraryID: 1, itemKey: "PAPER001" }],
          attachments: [],
          notes: [],
          annotations: [],
          collections: [],
        },
      },
      {
        id: "test",
        displayName: "Test",
        baseURL: "https://example.test",
        apiKey: "",
        model: "test",
        protocol: "native-tools",
        streaming: false,
        reasoningEnabled: false,
        reasoningEffort: "low",
        timeoutMs: 1000,
        contextBudgetChars: 100000,
        evidenceBudgetChars: 60000,
      },
      "Test",
      { maxToolCalls: 10, maxAttachments: 20 },
      { onRun() {}, onAssistantDelta() {}, onToolResult() {}, onApproval() {} },
    );
    expect(result.run.status).toBe("completed");
    expect(result.run.toolCallCount).toBe(2);
    expect(exposed[0]).toEqual(["get_current_context"]);
    expect(exposed[1]).toContain("verify_candidates");
    expect(exposed[1]).toContain("plan_search");
    expect(result.sources).toHaveLength(1);
  });
  it("reads a paper with annotation objects without querying NaN IDs", async () => {
    const { paper, getAsync } = library();
    const retriever = new ZoteroRetriever();
    const found = await retriever.getItems([{ libraryID: 1, itemKey: paper.key }]);
    expect(found.items).toHaveLength(1);
    expect(found.items[0].attachmentRefs?.[0].itemKey).toBe("PDF00001");
    expect(found.items[0].sourceID).toBe(found.sources[0].sourceID);
    expect(getAsync.mock.calls.every(([id]) => Number.isInteger(id))).toBe(true);
    expect(
      await retriever.listAnnotations({ libraryID: 1, itemKey: paper.key }),
    ).toHaveLength(1);
  });

  it("resolves an explicitly attached reader PDF to its parent only once", async () => {
    library();
    const result = await new ZoteroRetriever().getItems([
      { libraryID: 1, itemKey: "PDF00001" },
      { libraryID: 1, itemKey: "PAPER001" },
    ]);
    expect(result.items.map((item) => item.item.itemKey)).toEqual(["PAPER001"]);
  });

  it("verifies explicit paper attachments without requiring a search plan", async () => {
    library();
    const retriever = new ZoteroRetriever();
    const read = vi.spyOn(retriever, "readSnippets").mockResolvedValue([]);
    const registry = new ToolRegistry(retriever);
    const context = {
      conversationID: "test",
      context: {
        refs: {
          items: [{ libraryID: 1, itemKey: "PAPER001" }],
          attachments: [],
          notes: [],
          annotations: [],
          collections: [],
        },
      },
      maxAttachments: 20,
      evidenceBudget: { remainingChars: 30000 },
    };
    const resolved = await registry.execute(
      { id: "context", name: "get_current_context", arguments: {} },
      context,
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.sources).toHaveLength(1);
    const verified = await registry.execute(
      {
        id: "verify",
        name: "verify_candidates",
        arguments: {
          sourceIDs: [resolved.sources![0].sourceID],
          terms: ["Method Alpha"],
        },
      },
      context,
    );
    expect(verified.ok).toBe(true);
    expect(read.mock.calls[0][0][0].itemKey).toBe("PDF00001");
    expect((verified.content as any).attachmentsInspected).toBe(1);
    registry.clearSources();
    expect(registry.resolveSources([resolved.sources![0].sourceID])).toEqual([]);
  });

  it("starts attached-paper questions with inspection and keeps writes approval-gated", () => {
    expect(initialAgentState("Does this paper use Method Alpha?", true)).toBe(
      "context-inspection",
    );
    expect(initialAgentState("Find papers by an author", false)).toBe(
      "search-planning",
    );
    expect(initialAgentState("add tags", true)).toBe("write-proposal");
    const definitions = ["plan_search", "get_current_context", "propose_add_tags"].map(
      (name) => ({ function: { name } }),
    );
    expect(
      toolsForAgentState(definitions, "context-inspection", "question").map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["get_current_context"]);
    expect(
      transitionAfterTool("context-inspection", {
        toolCallID: "c",
        name: "get_current_context",
        ok: true,
        content: {},
        summary: "Read",
        resultCount: 1,
      }),
    ).toBe("evidence-verification");
  });

  it("unlocks verification after resolving a follow-up but not an empty context", () => {
    const resolved = {
      toolCallID: "context",
      name: "get_current_context",
      ok: true,
      content: {},
      summary: "Resolved",
      resultCount: 8,
    };
    expect(transitionAfterTool("search-planning", resolved)).toBe(
      "evidence-verification",
    );
    expect(
      transitionAfterTool("search-planning", { ...resolved, resultCount: 0 }),
    ).toBe("search-planning");
    expect(transitionAfterTool("search-planning", { ...resolved, ok: false })).toBe(
      "search-planning",
    );
    const definitions = [
      "verify_candidates",
      "read_attachment_snippets",
      "propose_add_tags",
    ].map((name) => ({ function: { name } }));
    expect(
      toolsForAgentState(definitions, "search-revision", "read previous paper").map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["verify_candidates", "read_attachment_snippets"]);
  });

  it.each([
    { authors: ["Alice"] },
    { yearMin: 2023 },
    { yearMax: 2019 },
    { languages: ["Chinese"] },
    { itemTypes: ["book"] },
    { collectionKeys: ["OTHER"] },
    { excluded: ["unwanted"] },
    { excludedTitles: ["An unwanted topic"] },
  ])("applies hard restrictions to semantic-only candidates: %j", async (filter) => {
    library();
    const retriever = new ZoteroRetriever({
      searchPapers: async () => [
        { libraryID: 1, itemKey: "PAPER001", score: 0.99, sourceFields: ["abstract"] },
      ],
    });
    vi.spyOn(retriever as any, "recallExactTitles").mockResolvedValue([]);
    vi.spyOn(retriever as any, "recallRegularItems").mockResolvedValue({
      ids: [],
      provenanceByID: new Map(),
    });
    vi.spyOn(retriever as any, "recallFulltextItems").mockResolvedValue({
      ids: [],
      hitsByParentID: new Map(),
    });
    vi.spyOn(retriever as any, "toDocument").mockResolvedValue({
      item: { libraryID: 1, itemKey: "PAPER001" },
      title: "An unwanted topic",
      abstract: "Relevant semantic content",
      authors: ["Bob"],
      tags: [],
      year: 2020,
      language: "English",
      itemType: "journalArticle",
      collections: ["COLLECT1"],
    });
    const result = await retriever.searchLibrary(
      normalizeQuery({ phrase: "topic", ...filter }),
      "find topic",
    );
    expect(result.items).toEqual([]);
  });

  it("does not require literal concept matches for otherwise valid semantic recall", async () => {
    library();
    const retriever = new ZoteroRetriever({
      searchPapers: async () => [
        { libraryID: 1, itemKey: "PAPER001", score: 0.9, sourceFields: ["abstract"] },
      ],
    });
    vi.spyOn(retriever as any, "recallExactTitles").mockResolvedValue([]);
    vi.spyOn(retriever as any, "recallRegularItems").mockResolvedValue({
      ids: [],
      provenanceByID: new Map(),
    });
    vi.spyOn(retriever as any, "recallFulltextItems").mockResolvedValue({
      ids: [],
      hitsByParentID: new Map(),
    });
    const result = await retriever.searchLibrary(
      normalizeQuery({ required: [["光谱"]] }),
      "光谱",
    );
    expect(result.items).toHaveLength(1);
  });

  it("protects exact identities ahead of semantic reservation and budget truncation", () => {
    const make = (key: string, title: string) => ({
      item: { libraryID: 1, itemKey: key },
      title,
      abstract: "",
      authors: [],
      tags: [],
      score: 0.5,
      matchedFields: [],
    });
    const exact = make("EXACT001", "A detailed study of stellar spectra");
    const fuzzy = Array.from({ length: 20 }, (_, i) =>
      make(`FUZZY${i}`, `Other study ${i}`),
    );
    const ranked = fuseHybridResults([exact, ...fuzzy], fuzzy, 5, 0.8, [
      exact.title.toUpperCase(),
    ]);
    expect(ranked).toHaveLength(5);
    expect(ranked[0].item.itemKey).toBe("EXACT001");
    expect(new Set(ranked.map((entry) => entry.item.itemKey)).size).toBe(5);
  });

  it("instructs literal new-topic scope and distinguishes missing snippets from absence", () => {
    const prompt = retrievalStrategyPrompt("");
    expect(prompt).toContain("must not silently inherit the previous method");
    expect(prompt).toContain("Older sourceIDs expire between runs");
    expect(prompt).toContain("cannot prove whole-document absence");
  });
});
