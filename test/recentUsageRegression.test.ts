import { expect, it, vi } from "vitest";
import { normalizeQuery, rankDocuments } from "../src/retrieval/ranking";
import { collectionFollowup, isPagingFollowup } from "../src/agent/followupIntent";
import { ToolRegistry } from "../src/agent/toolRegistry";
import { filterToolDefinitions } from "../src/agent/agentRunner";

const ref = { libraryID: 1, itemKey: "PAPER001" };
function context() {
  return {
    conversationID: "chat",
    maxAttachments: 20,
    evidenceBudget: { remainingChars: 60000 },
    context: {
      refs: {
        items: [ref],
        attachments: [],
        notes: [],
        annotations: [],
        collections: [],
        hasEphemeralSelection: false,
      },
    },
  };
}
function candidate(sourceID = "fresh") {
  return {
    item: ref,
    sourceID,
    title: "Synthetic ecology paper",
    authors: Array.from({ length: 30 }, (_, i) => `Author ${i}`),
    attachmentRefs: [],
  };
}
it("preserves collection identifier semantics rather than treating keys as words", () => {
  const query = normalizeQuery({ collectionKeys: ["AbC12345"], phrase: "ecology" });
  expect(query.collectionKeys).toEqual(["ABC12345"]);
  expect(
    rankDocuments(
      [
        {
          ...candidate(),
          abstract: "ecology",
          tags: [],
          collections: ["ABC12345"],
        } as any,
      ],
      query,
    ),
  ).toHaveLength(1);
});
it("routes exact returned collection names only, with safe malformed-history fallback", () => {
  const definitions = [{ function: { name: "list_collections" } }];
  expect(filterToolDefinitions(definitions, "Example", true)).toHaveLength(1);
  expect(filterToolDefinitions(definitions, "Example")).toHaveLength(0);
  const history: any[] = [
    {
      role: "assistant",
      agentEvents: [{ name: "list_collections" }],
      protocolHistory: [
        {
          role: "tool",
          content: JSON.stringify({
            items: [{ key: "ABC12345", name: "Example collection" }],
          }),
        },
      ],
    },
    { role: "user", displayText: "Example collection" },
  ];
  expect(collectionFollowup(history)).toBe(true);
  history[1].displayText = "Find papers about ecology";
  expect(collectionFollowup(history)).toBe(false);
  history[0].protocolHistory[0].content = "incomplete JSON";
  expect(collectionFollowup(history)).toBe(false);
  expect(isPagingFollowup("继续翻完剩余21条候选")).toBe(true);
  expect(isPagingFollowup("换个话题找一篇论文")).toBe(false);
});

it("rejects exhaustive wording while undisplayed candidates remain", async () => {
  const registry = new ToolRegistry({} as any);
  (registry as any).remainingCandidates = [candidate()];
  const ctx = context();
  ctx.evidenceBudget.remainingChars = 0;
  const response = await registry.execute(
    {
      id: "finish",
      name: "finish_answer",
      arguments: {
        answer: "已把全部候选翻完，库中没有对应文章。",
        sourceIDs: [],
        evidenceInsufficient: true,
      },
    },
    ctx,
  );
  expect(response.ok).toBe(false);
  expect(JSON.stringify(response.content)).toContain("Unseen candidates remain");
});
it("returns all authors during explicit metadata verification, not preview truncation", async () => {
  const getItems = vi.fn(async () => ({
    items: [candidate()],
    sources: [{ sourceID: "fresh", item: ref, field: "title", label: "Synthetic" }],
  }));
  const registry = new ToolRegistry({ getItems } as any);
  const read = await registry.execute(
    { id: "r", name: "get_items", arguments: { refs: [ref] } },
    context(),
  );
  expect(read.ok).toBe(true);
  expect(getItems).toHaveBeenCalledWith([ref], true);
  expect((read.content as any).items[0].authors).toHaveLength(30);
  expect((read.content as any).items[0].authorsTruncated).toBe(false);
});
it("resumes only the preceding same-conversation turn, refreshing citation identities", async () => {
  const getItems = vi.fn(async () => ({
    items: [candidate()],
    sources: [{ sourceID: "fresh", item: ref, field: "title", label: "Synthetic" }],
  }));
  const registry = new ToolRegistry({ getItems } as any);
  registry.beginTurn("chat", "u1", undefined, false);
  (registry as any).activePlan = { id: "p1" };
  (registry as any).remainingCandidates = [candidate("old")];
  (registry as any).sourceWhitelist.set("old", { sourceID: "old", item: ref });
  expect(registry.beginTurn("chat", "u2", "u1", true)).toBe(true);
  expect(registry.resolveSources(["old"])).toEqual([]);
  const page = await registry.execute(
    { id: "page", name: "next_search_results", arguments: {} },
    context(),
  );
  expect(page.ok).toBe(true);
  expect((page.content as any).items[0].sourceID).toBe("fresh");
  expect(registry.coverageSummary()).toMatchObject({
    deliveredUniqueThisTurn: 1,
    deliveredUniqueInSession: 1,
    remainingCandidates: 0,
    resumedPaging: true,
  });
  expect(registry.beginTurn("other", "u3", "u2", true)).toBe(false);
  expect(registry.coverageSummary().deliveredUniqueInSession).toBe(0);
});
it("does not resume an edited earlier turn or a new topic", () => {
  const registry = new ToolRegistry({} as any);
  registry.beginTurn("chat", "u2", "u1", false);
  (registry as any).activePlan = { id: "p" };
  expect(registry.beginTurn("chat", "edited", "u0", true)).toBe(false);
  (registry as any).activePlan = { id: "p" };
  expect(registry.beginTurn("chat", "new", "edited", false)).toBe(false);
});
