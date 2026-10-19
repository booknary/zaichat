import { describe, expect, it, vi } from "vitest";
import { requiresContextualEvidence, ToolRegistry } from "../src/agent/toolRegistry";
import {
  fuseRecallBuckets,
  fulltextDiscoveryTerms,
  interleaveUniqueIDs,
  MAX_FULLTEXT_DISCOVERY_CANDIDATES,
  titleRecallTokens,
  validItemIDs,
  ZoteroRetriever,
} from "../src/host/zoteroRetriever";
import type { EvidenceBudgetState, SourceReference } from "../src/core/types";

describe("retrieval verification boundary", () => {
  it("pages recalled candidates without reranking, rejects premature absence, and resets between runs", async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      item: { libraryID: 1, itemKey: `TEST${String(i).padStart(4, "0")}` },
      sourceID: `src-test-${i}`,
      title: `Synthetic candidate ${i}`,
      abstract: "Independent synthetic evidence",
      authors: [],
      tags: [],
      attachmentRefs: [],
    }));
    const sources = items.map((item) => ({
      sourceID: item.sourceID,
      item: item.item,
      label: item.title,
    }));
    const retriever = { searchLibrary: vi.fn(async () => ({ items, sources })) };
    const registry = new ToolRegistry(retriever as any);
    const context = {
      conversationID: "paging",
      userQuery: "adaptive mechanism",
      context: { refs: { items: [], attachments: [] } },
      maxAttachments: 20,
      evidenceBudget: { remainingChars: 60000 } as EvidenceBudgetState,
    };
    const plan = structuredPlan("adaptive mechanism", [
      {
        term: "adaptive mechanism",
        relation: "canonical",
        confidence: "high",
        origin: "model_inferred",
      },
    ]);
    const first = await registry.execute(
      { id: "p", name: "plan_search", arguments: plan },
      context,
    );
    expect(first.ok).toBe(true);
    expect(first.resultCount).toBe(18);
    expect((first.content as any).remainingCandidates).toBe(32);
    expect(retriever.searchLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
      context.userQuery,
      { deferFulltext: true },
    );
    const premature = await registry.execute(
      {
        id: "f",
        name: "finish_answer",
        arguments: { answer: "No match", sourceIDs: [], evidenceInsufficient: true },
      },
      context,
    );
    expect(premature.ok).toBe(false);
    expect(JSON.stringify(premature)).toContain("Unseen candidate pages");
    const second = await registry.execute(
      { id: "n1", name: "next_search_results", arguments: {} },
      context,
    );
    const third = await registry.execute(
      { id: "n2", name: "next_search_results", arguments: {} },
      context,
    );
    expect(second.resultCount).toBe(18);
    expect(third.resultCount).toBe(14);
    expect((third.content as any).remainingCandidates).toBe(0);
    const delivered = [first, second, third].flatMap((result) =>
      (result.content as any).items.map((item: any) => item.sourceID),
    );
    expect(delivered).toEqual(items.map((item) => item.sourceID));
    expect(second.sources?.map((source) => source.sourceID)).toContain("src-test-25");
    expect(retriever.searchLibrary).toHaveBeenCalledTimes(1);
    registry.clearSources();
    const stale = await registry.execute(
      { id: "stale", name: "next_search_results", arguments: {} },
      context,
    );
    expect(stale.ok).toBe(false);
  });

  it("executes a plan when a non-strict provider returns token-array combinations", async () => {
    const retriever = {
      searchLibrary: vi.fn(async () => ({
        items: [],
        sources: [],
        discovery: {
          exactTitleCandidates: 0,
          metadataCandidates: 0,
          fulltextCandidates: 0,
          fulltextRoutes: 0,
          semanticCandidates: 0,
        },
      })),
    };
    const registry = new ToolRegistry(retriever as any);
    const context = {
      conversationID: "conversation-provider-shape",
      userQuery: "有一篇关于两次基因组创新的文章",
      context: { refs: { items: [], attachments: [] } },
      maxAttachments: 20,
      evidenceBudget: { remainingChars: 60000 } as EvidenceBudgetState,
    };
    const argumentsValue = structuredPlan("genomic innovation", [
      {
        term: "genomic innovation",
        relation: "canonical",
        confidence: "high",
        origin: "model_inferred",
      },
      {
        term: "genomic novelty",
        relation: "exact_synonym",
        confidence: "high",
        origin: "model_inferred",
      },
    ]);
    argumentsValue.searchCombinations = [
      ["two", "genomic innovation"],
      ["two bursts", "genomic novelty"],
      ["dual", "genome novelty"],
    ] as any;

    const response = await registry.execute(
      { id: "plan-provider-shape", name: "plan_search", arguments: argumentsValue },
      context,
    );

    expect(response.ok).toBe(true);
    expect(retriever.searchLibrary).toHaveBeenCalledWith(
      expect.objectContaining({
        searchCombinations: [
          "two genomic innovation",
          "two bursts genomic novelty",
          "dual genome novelty",
        ],
      }),
      context.userQuery,
      { deferFulltext: true },
    );
  });

  it("describes whole-library discovery and candidate verification consistently", () => {
    const registry = new ToolRegistry({} as any);
    const definitions = registry.definitions();
    const byName = (name: string) =>
      definitions.find((entry) => entry.function.name === name).function.description;
    expect(byName("plan_search")).toContain("indexed full text");
    expect(byName("search_fulltext")).toContain(
      "deferred whole-library discovery use expand_search",
    );
    expect(byName("search_fulltext")).not.toContain("Call search_library first");
    expect(byName("finish_answer")).toContain("bibliographic identification");
  });

  it("drops NaN and other invalid Zotero item identifiers", () => {
    expect(validItemIDs([1, "2", NaN, undefined, 0, -3, "bad", 4.5])).toEqual([1, 2]);
  });

  it("interleaves recall buckets so a broad first term cannot starve later concepts", () => {
    expect(interleaveUniqueIDs([[1, 2, 3, 4], [90], [100]], 4)).toEqual([
      1, 90, 100, 2,
    ]);
  });

  it("fuses independent routes so a deep multi-concept match survives truncation", () => {
    expect(
      fuseRecallBuckets(
        [
          { term: "genomic", ids: [1, 2, 3, 4, 99] },
          { term: "two", ids: [10, 11, 12, 99] },
          { term: "unrelated exact phrase", ids: [7] },
        ],
        3,
      ),
    ).toEqual([99, 7, 1]);
  });

  it("sends supplied titles through Zotero title is/contains searches", async () => {
    const previousZotero = (globalThis as any).Zotero;
    const conditions: Array<[string, string, string]> = [];
    class Search {
      addCondition(field: string, operator: string, value: string) {
        conditions.push([field, operator, value]);
      }
      async search() {
        return [10];
      }
    }
    (globalThis as any).Zotero = {
      Search,
      logError: vi.fn(),
    };
    try {
      const retriever = new ZoteroRetriever() as any;
      const title =
        "The origin of land plants is rooted in two bursts of genomic novelty";
      expect(await retriever.recallExactTitles(1, [title])).toEqual([10]);
      expect(conditions).toContainEqual(["title", "is", title]);
      expect(conditions).toContainEqual(["title", "contains", title]);
      expect(
        conditions.some(
          ([field, operator, value]) =>
            field === "title" &&
            operator === "contains" &&
            value !== title &&
            value.includes("origin of land plants"),
        ),
      ).toBe(true);
    } finally {
      (globalThis as any).Zotero = previousZotero;
    }
  });

  it("extracts distinctive title tokens for resilient title recall", () => {
    expect(
      titleRecallTokens(
        "The origin of land plants is rooted in two bursts of genomic novelty",
      ),
    ).toEqual(
      expect.arrayContaining([
        "origin",
        "plants",
        "rooted",
        "bursts",
        "genomic",
        "novelty",
      ]),
    );
  });

  it("keeps recall candidates out of the source whitelist until metadata is verified", async () => {
    const source: SourceReference = {
      sourceID: "verified-1",
      item: { libraryID: 1, itemKey: "ITEM0001" },
      label: "Verified paper",
    };
    const candidate = {
      sourceID: source.sourceID,
      item: source.item,
      title: source.label,
      authors: [],
      tags: [],
      attachmentRefs: [],
      score: 0.9,
      matchedFields: ["title"],
    };
    const retriever = {
      searchLibrary: vi.fn(async () => ({ items: [candidate], sources: [source] })),
      getItems: vi.fn(async () => ({ items: [candidate], sources: [source] })),
    };
    const registry = new ToolRegistry(retriever as any);
    const context = {
      conversationID: "conversation-1",
      context: {
        refs: {
          items: [],
          attachments: [],
          notes: [],
          annotations: [],
          collections: [],
        },
      },
      maxAttachments: 20,
      evidenceBudget: { remainingChars: 60000 } as EvidenceBudgetState,
    };

    const plan = await registry.execute(
      {
        id: "plan-1",
        name: "plan_search",
        arguments: {
          ...searchExpansion("genome innovation"),
          required: [["genome"], ["innovation", "novelty"]],
          optional: [],
          excluded: [],
          rationale: "Search independent concepts with synonyms",
        },
      },
      context,
    );
    expect(plan.sources).toEqual([source]);
    expect((plan.content as any).evidenceStatus).toBe(
      "verified-bibliographic-candidates",
    );
    expect((plan.content as any).executedRecallTerms).toEqual(
      expect.arrayContaining(["genome innovation", "genome innovation evolution"]),
    );
    expect(registry.resolveSources([source.sourceID])).toEqual([source]);
    expect(plan.resultCount).toBe(1);
    expect(plan.summary).toMatch(
      /^Created topic search plan \[unspecified; .*routes \d+\+\d+ fallback; observed 0\] \(1 English queries, 3 combinations\) returned 1 candidates$/,
    );

    const verified = await registry.execute(
      {
        id: "items-1",
        name: "get_items",
        arguments: { refs: [source.item] },
      },
      context,
    );
    expect(verified.sources).toEqual([source]);
    expect(registry.resolveSources([source.sourceID])).toEqual([source]);

    const fabricated = await registry.execute(
      {
        id: "items-fabricated",
        name: "get_items",
        arguments: { refs: [{ libraryID: 1, itemKey: "NOTACAND" }] },
      },
      context,
    );
    expect((fabricated.content as any).items).toEqual([]);
    expect(fabricated.sources).toEqual([]);
    expect((retriever.getItems as any).mock.calls).toHaveLength(1);

    await registry.execute(
      {
        id: "plan-2",
        name: "plan_search",
        arguments: {
          ...searchExpansion("revised concept"),
          required: [["revised concept"]],
          optional: [],
          excluded: [],
          rationale:
            "Revision after the first pass: the previous candidates were not topically relevant",
        },
      },
      context,
    );
    expect(registry.topCandidateRefs()).toEqual([candidate.item]);
    expect(registry.resolveSources([source.sourceID])).toEqual([source]);

    const thirdPlan = await registry.execute(
      {
        id: "plan-3",
        name: "plan_search",
        arguments: {
          ...searchExpansion("third concept"),
          required: [["third concept"]],
          optional: [],
          excluded: [],
          rationale: "Try yet another plan",
          revisionReason: "The second plan was also weak",
        },
      },
      context,
    );
    expect(thirdPlan.ok).toBe(false);
    expect(thirdPlan.summary).toContain("Only one search-plan revision");
  });

  it("accepts only candidate-observed terms visible in the previous result", async () => {
    const candidate = {
      item: { libraryID: 1, itemKey: "ITEM0001" },
      title: "Observed field expression in alpha studies",
      abstractExcerpt: "A candidate-specific account of the alpha relation.",
      authors: [],
      tags: ["alpha relation"],
      attachmentRefs: [],
      fulltextMatchTerms: ["field expression"],
      score: 0.9,
      matchedFields: ["title"],
    };
    const registry = new ToolRegistry({
      searchLibrary: vi.fn(async () => ({ items: [candidate], sources: [] })),
    } as any);
    const context = {
      conversationID: "conversation-1",
      userQuery: "Find the remembered alpha item",
      context: {
        refs: {
          items: [],
          attachments: [],
          notes: [],
          annotations: [],
          collections: [],
        },
      },
      maxAttachments: 20,
      evidenceBudget: { remainingChars: 60000 } as EvidenceBudgetState,
    };

    const initial = await registry.execute(
      {
        id: "candidate-plan-1",
        name: "plan_search",
        arguments: structuredPlan("alpha canonical", [
          {
            term: "alpha canonical",
            relation: "canonical",
            confidence: "high",
            origin: "model_inferred",
          },
        ]),
      },
      context,
    );
    expect(initial.ok).toBe(true);

    const revised = await registry.execute(
      {
        id: "candidate-plan-2",
        name: "plan_search",
        arguments: {
          ...structuredPlan("observed field expression", [
            {
              term: "alpha canonical",
              relation: "canonical",
              confidence: "high",
              origin: "model_inferred",
            },
            {
              term: "observed field expression",
              relation: "established_term",
              confidence: "high",
              origin: "candidate_observed",
            },
            {
              term: "invented unseen expression",
              relation: "established_term",
              confidence: "high",
              origin: "candidate_observed",
            },
          ]),
          revisionReason:
            "The previous title exposed a more specific disciplinary expression",
        },
      },
      context,
    );
    expect(revised.ok).toBe(true);
    const revisedVariants = (revised.content as any).plan.concepts[0].variants;
    expect(revisedVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          term: "observed field expression",
          origin: "candidate_observed",
        }),
        expect.objectContaining({
          term: "invented unseen expression",
          origin: "model_inferred",
        }),
      ]),
    );
    expect(
      (revised.content as any).terminologyDiagnostics.candidateObservedTerms,
    ).toEqual(["observed field expression"]);
    expect((revised.content as any).executedRecallTerms).toContain(
      "observed field expression",
    );
  });

  it("verifies full text only inside the current metadata candidate set", async () => {
    const candidate = {
      item: { libraryID: 1, itemKey: "ITEM0001" },
      title: "Genome innovation",
      authors: [],
      tags: [],
      attachmentRefs: [],
      score: 0.9,
      matchedFields: ["title"],
    };
    const searchFulltext = vi.fn(async () => ({ items: [candidate], sources: [] }));
    const retriever = {
      searchLibrary: vi.fn(async () => ({ items: [candidate], sources: [] })),
      searchFulltext,
    };
    const registry = new ToolRegistry(retriever as any);
    const context = {
      conversationID: "conversation-1",
      context: {
        refs: {
          items: [],
          attachments: [],
          notes: [],
          annotations: [],
          collections: [],
        },
      },
      maxAttachments: 20,
      evidenceBudget: { remainingChars: 60000 } as EvidenceBudgetState,
    };

    const noPlan = await registry.execute(
      {
        id: "fulltext-before-plan",
        name: "search_fulltext",
        arguments: { planID: "missing" },
      },
      context,
    );
    expect(noPlan.ok).toBe(false);
    expect(searchFulltext).not.toHaveBeenCalled();

    const plan = await registry.execute(
      {
        id: "plan-1",
        name: "plan_search",
        arguments: {
          ...searchExpansion("genome innovation"),
          required: [["genome"], ["innovation"]],
          optional: [],
          excluded: [],
          rationale: "Split the request into required concepts",
        },
      },
      context,
    );
    const planID = (plan.content as any).plan.id;

    await registry.execute(
      {
        id: "fulltext-before-recall",
        name: "search_fulltext",
        arguments: { planID },
      },
      context,
    );
    expect(searchFulltext).toHaveBeenLastCalledWith(expect.anything(), 12, [
      candidate.item,
    ]);
    expect(registry.topCandidateRefs()).toEqual([candidate.item]);
  });

  it("batch-verifies candidate source IDs with one bounded snippet operation", async () => {
    const attachment = { libraryID: 1, itemKey: "ATTACH01" };
    const candidate = {
      sourceID: "candidate-source",
      item: { libraryID: 1, itemKey: "ITEM0001" },
      title: "Synthetic candidate",
      authors: [],
      tags: [],
      attachmentRefs: [attachment],
      score: 0.9,
      matchedFields: ["title"],
    };
    const source = {
      sourceID: "candidate-source",
      item: candidate.item,
      attachment,
      label: candidate.title,
      field: "title",
    };
    const readSnippets = vi.fn(async () => [
      {
        sourceID: "snippet-source",
        item: candidate.item,
        attachment,
        text: "Bounded synthetic evidence",
        field: "fulltext",
        score: 1,
      },
    ]);
    const registry = new ToolRegistry({
      searchLibrary: vi.fn(async () => ({ items: [candidate], sources: [source] })),
      readSnippets,
    } as any);
    const context = {
      conversationID: "conversation-1",
      context: {
        refs: {
          items: [],
          attachments: [],
          notes: [],
          annotations: [],
          collections: [],
        },
      },
      maxAttachments: 20,
      evidenceBudget: { remainingChars: 60000 } as EvidenceBudgetState,
    };
    await registry.execute(
      {
        id: "batch-plan",
        name: "plan_search",
        arguments: {
          ...searchExpansion("synthetic concept"),
          required: [["synthetic concept"]],
          optional: [],
          excluded: [],
          rationale: "Create candidate set",
        },
      },
      context,
    );
    const verified = await registry.execute(
      {
        id: "batch-verify",
        name: "verify_candidates",
        arguments: {
          sourceIDs: ["candidate-source"],
          terms: ["synthetic concept"],
        },
      },
      context,
    );
    expect(readSnippets).toHaveBeenCalledTimes(1);
    expect(readSnippets).toHaveBeenCalledWith(
      [attachment],
      ["synthetic concept"],
      8,
      3,
      700,
      { exclude: [] },
    );
    expect(verified.sources?.[0].sourceID).toBe("snippet-source");
    expect(verified.summary).toContain("Batch-verified 1 candidates");
  });

  it("discovers and deduplicates a fulltext-only method hit through Zotero's index", async () => {
    const previousZotero = (globalThis as any).Zotero;
    const conditions: Array<[string, string, string]> = [];
    class Search {
      private ownConditions: Array<[string, string, string]> = [];
      addCondition(field: string, operator: string, value = "") {
        const condition: [string, string, string] = [field, operator, value];
        this.ownConditions.push(condition);
        conditions.push(condition);
      }
      async search() {
        if (
          this.ownConditions.some(
            ([field, , value]) =>
              field === "fulltextContent" && value === "progressive cactus",
          )
        )
          return [101, 101];
        if (
          this.ownConditions.some(
            ([field, , value]) =>
              field === "quicksearch-titleCreatorYear" &&
              value === "progressive cactus",
          )
        )
          return [10];
        return [];
      }
    }
    const parent = {
      id: 10,
      libraryID: 1,
      key: "PARENT01",
      isRegularItem: () => true,
    };
    const attachment = {
      id: 101,
      libraryID: 1,
      key: "ATTACH01",
      parentItemID: 10,
      itemTypeID: 14,
      isAttachment: () => true,
      getField: () => "",
      getDisplayTitle: () => "Indexed PDF",
    };
    (globalThis as any).Zotero = {
      Libraries: { userLibraryID: 1 },
      Search,
      Items: {
        getAsync: vi.fn(async (id: number) =>
          id === attachment.id ? attachment : id === parent.id ? parent : undefined,
        ),
      },
      ItemTypes: {
        getName: (id: number) => (id === 14 ? "attachment" : "journalArticle"),
      },
      logError: vi.fn(),
    };
    try {
      const retriever = new ZoteroRetriever() as any;
      retriever.toDocument = vi.fn(async () => ({
        item: { libraryID: 1, itemKey: "PARENT01" },
        title: "A plant pangenome study",
        abstract: "A comparative analysis without naming the alignment software.",
        authors: [],
        tags: [],
        notes: [],
        annotations: [],
        collections: [],
        attachmentRefs: [],
      }));
      retriever.readIndexedText = vi.fn(async () => {
        throw new Error("whole cache must not be read during discovery");
      });
      const query = {
        exactTitles: [],
        englishQueries: ["progressive cactus"],
        searchCombinations: [
          "plant genome alignment",
          "progressive cactus plants",
          "whole genome alignment cactus",
        ],
        required: [["progressive cactus", "cactus"]],
        optional: [],
        excluded: [],
        limit: 12,
      };
      const found = await retriever.searchLibrary(query);
      expect(found.items).toHaveLength(1);
      expect(found.items[0].item.itemKey).toBe("PARENT01");
      expect(found.items[0].matchedFields).toContain("fulltext");
      expect(found.items[0].provenance).toEqual(
        expect.arrayContaining(["metadata", "fulltext"]),
      );
      expect(found.items[0].fulltextMatchTerms).toContain("progressive cactus");
      expect(found.items[0].attachmentRefs).toContainEqual(
        expect.objectContaining({ itemKey: "ATTACH01" }),
      );
      expect(found.discovery.fulltextCandidates).toBe(1);
      expect(retriever.readIndexedText).not.toHaveBeenCalled();
      expect(conditions).toContainEqual([
        "fulltextContent",
        "contains",
        "progressive cactus",
      ]);
      expect(conditions.some(([field]) => field === "tag")).toBe(true);
    } finally {
      (globalThis as any).Zotero = previousZotero;
    }
  });

  it("keeps indexed-fulltext discovery routes and candidate counts bounded", () => {
    const query = {
      englishQueries: Array.from({ length: 30 }, (_, index) => `method ${index}`),
      searchCombinations: Array.from(
        { length: 30 },
        (_, index) => `method combination ${index}`,
      ),
      required: [["progressive cactus"]],
      optional: [],
      excluded: [],
      limit: 50,
    };
    expect(fulltextDiscoveryTerms(query)).toHaveLength(24);
    expect(
      fuseRecallBuckets(
        Array.from({ length: 40 }, (_, index) => ({
          term: `route ${index}`,
          ids: [index + 1],
        })),
        MAX_FULLTEXT_DISCOVERY_CANDIDATES,
      ),
    ).toHaveLength(MAX_FULLTEXT_DISCOVERY_CANDIDATES);
  });

  it("bounds contextual snippets and rejects unsupported method-use claims", async () => {
    const source: SourceReference = {
      sourceID: "metadata-source",
      item: { libraryID: 1, itemKey: "PARENT01" },
      attachment: { libraryID: 1, itemKey: "ATTACH01" },
      label: "Candidate paper",
      field: "fulltext",
    };
    const candidate = {
      sourceID: source.sourceID,
      item: source.item,
      title: source.label,
      authors: [],
      tags: [],
      attachmentRefs: [source.attachment],
      score: 0.8,
      matchedFields: ["fulltext"],
      provenance: ["fulltext"],
    };
    const readSnippets = vi.fn(async () => [
      {
        sourceID: "snippet-source",
        item: source.item,
        attachment: source.attachment,
        text: "We used Progressive Cactus for the whole-genome alignment.",
        field: "fulltext",
        score: 1,
      },
    ]);
    const registry = new ToolRegistry({
      searchLibrary: vi.fn(async () => ({
        items: [candidate],
        sources: [source],
        discovery: {
          exactTitleCandidates: 0,
          metadataCandidates: 0,
          fulltextCandidates: 1,
          fulltextRoutes: 4,
        },
      })),
      readSnippets,
    } as any);
    const context = {
      conversationID: "conversation-1",
      context: {
        refs: {
          items: [],
          attachments: [],
          notes: [],
          annotations: [],
          collections: [],
        },
      },
      maxAttachments: 20,
      evidenceBudget: { remainingChars: 60000 } as EvidenceBudgetState,
    };
    const plan = await registry.execute(
      {
        id: "plan-method",
        name: "plan_search",
        arguments: {
          ...searchExpansion("progressive cactus"),
          required: [["progressive cactus", "cactus"]],
          optional: [],
          excluded: [],
          rationale: "Find method use",
        },
      },
      context,
    );
    expect(plan.ok).toBe(true);
    const unsupported = await registry.execute(
      {
        id: "finish-unsupported",
        name: "finish_answer",
        arguments: {
          answer: "The study used Progressive Cactus.",
          sourceIDs: [source.sourceID],
          evidenceInsufficient: false,
        },
      },
      context,
    );
    expect(unsupported.ok).toBe(false);
    expect(unsupported.summary).toContain("requires a contextual source");
    expect(requiresContextualEvidence("The study used Progressive Cactus.")).toBe(true);

    const snippets = await registry.execute(
      {
        id: "snippets-method",
        name: "read_attachment_snippets",
        arguments: {
          attachments: Array.from({ length: 20 }, () => source.attachment),
          terms: ["Progressive Cactus"],
        },
      },
      context,
    );
    expect(snippets.ok).toBe(true);
    const repair = await registry.execute(
      {
        id: "repair-metadata-citation",
        name: "finish_answer",
        arguments: {
          answer: "The study used Progressive Cactus.",
          sourceIDs: [source.sourceID],
          evidenceInsufficient: false,
        },
      },
      context,
    );
    expect(repair.ok).toBe(false);
    expect((repair.content as any).availableEvidence).toEqual([
      { sourceID: "snippet-source", item: source.item },
    ]);
    expect(readSnippets).toHaveBeenCalledTimes(1);
    expect(readSnippets).toHaveBeenCalledWith(
      [source.attachment],
      ["Progressive Cactus"],
      8,
      3,
      700,
      { exclude: [] },
    );
    const supported = await registry.execute(
      {
        id: "finish-supported",
        name: "finish_answer",
        arguments: {
          answer: "The study used Progressive Cactus.",
          sourceIDs: ["snippet-source"],
          evidenceInsufficient: false,
        },
      },
      context,
    );
    expect(supported.ok).toBe(true);
  });

  it("reads indexed caches for bounded candidates without using Zotero.Search", async () => {
    const previousZotero = (globalThis as any).Zotero;
    const parent = {
      id: 10,
      libraryID: 1,
      key: "ITEM0001",
      isRegularItem: () => true,
      getAttachments: () => [101],
    };
    const attachment = {
      id: 101,
      libraryID: 1,
      key: "ATTACH01",
      isAttachment: () => true,
    };
    (globalThis as any).Zotero = {
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: vi.fn(() => parent),
        getAsync: vi.fn(async () => attachment),
      },
      ItemTypes: { getName: () => "journalArticle" },
    };
    try {
      const retriever = new ZoteroRetriever() as any;
      retriever.readIndexedText = vi.fn(
        async () => "The paper reports a two-stage genome innovation burst.",
      );
      retriever.toDocument = vi.fn(async () => ({
        item: { libraryID: 1, itemKey: "ITEM0001" },
        title: "A two-stage genome innovation burst",
        abstract: "",
        authors: [],
        tags: [],
        notes: [],
        annotations: [],
        collections: [],
        attachmentRefs: [],
      }));

      const found = await retriever.searchFulltext(
        {
          required: [["genome innovation"]],
          optional: [],
          excluded: [],
          limit: 12,
        },
        12,
        [{ libraryID: 1, itemKey: "ITEM0001" }],
      );

      expect(found.items).toHaveLength(1);
      expect(found.items[0].matchedFields).toContain("fulltext");
      expect(retriever.readIndexedText).toHaveBeenCalledWith(attachment);
      expect((globalThis as any).Zotero.Search).toBeUndefined();

      retriever.readIndexedText.mockResolvedValueOnce(
        "This cached paper discusses an unrelated subject.",
      );
      const unrelated = await retriever.searchFulltext(
        {
          required: [["genome innovation"]],
          optional: [],
          excluded: [],
          limit: 12,
        },
        12,
        [{ libraryID: 1, itemKey: "ITEM0001" }],
      );
      expect(unrelated.items).toEqual([]);
    } finally {
      (globalThis as any).Zotero = previousZotero;
    }
  });
});

function searchExpansion(term: string) {
  return {
    exactTitles: [],
    englishQueries: [term],
    searchCombinations: [term, `${term} evolution`, `${term} biology`],
  };
}

function structuredPlan(
  term: string,
  variants: Array<{
    term: string;
    relation: string;
    confidence: string;
    origin: string;
  }>,
) {
  return {
    discipline: "synthetic discipline",
    subfield: "controlled examples",
    intent: "remembered_item",
    concepts: [
      {
        label: "alpha concept",
        meaning: "A remembered concept in the synthetic discipline",
        role: "required",
        variants,
      },
    ],
    exactTitles: [],
    titleHypotheses: [
      `${term} across contrasting environments`,
      `an unexpected account of ${term}`,
      `reconstructing the origins of ${term}`,
      `multiple pathways produce ${term}`,
    ],
    englishQueries: [term],
    searchCombinations: [term, `${term} study`, `${term} framework`],
    excluded: [],
    rationale: "Use a bounded structured terminology plan",
  };
}
