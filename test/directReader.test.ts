import { afterEach, expect, it, vi } from "vitest";
import { DirectReader } from "../src/host/directReader";
import { ToolRegistry } from "../src/agent/toolRegistry";
import { initialAgentState, toolsForAgentState } from "../src/agent/agentState";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const field = vi.fn(
    (name: string) =>
      ({
        title: "Synthetic article",
        abstractNote: "<p>" + "Abstract evidence. ".repeat(40) + "</p>",
        date: "2024",
      })[name],
  );
  const paper = {
    id: 1,
    libraryID: 1,
    key: "PAPER001",
    isRegularItem: () => true,
    getField: field,
  };
  const other = { ...paper, id: 2, key: "PAPER002" };
  const child = {
    id: 2,
    name: "Child",
    loadDataType: vi.fn(),
    getChildItems: () => [paper, other],
    getChildCollections: () => [],
  };
  const root = {
    id: 1,
    name: "Root",
    loadDataType: vi.fn(),
    getChildItems: () => [paper],
    getChildCollections: () => [child],
  };
  vi.stubGlobal("Zotero", {
    Libraries: { userLibraryID: 1 },
    Collections: {
      getByLibraryAndKeyAsync: async (_lib: number, key: string) =>
        key === "ROOT0001" ? root : undefined,
    },
    Items: {
      loadDataTypes: vi.fn(async () => {}),
      getByLibraryAndKeyAsync: async (_lib: number, key: string) =>
        [paper, other].find((item) => item.key === key),
    },
  });
  return { field, root };
}
it("lists collection metadata without reading abstracts and deduplicates recursive members", async () => {
  const { field, root } = fixture();
  const reader = new DirectReader();
  expect((await reader.collection("ROOT0001", false, 0)).total).toBe(1);
  const all = await reader.collection("ROOT0001", true, 0);
  expect(all.total).toBe(2);
  expect(all.scanTruncated).toBe(false);
  expect(field).not.toHaveBeenCalledWith("abstractNote");
  root.getChildItems = () => [];
  expect((await reader.collection("ROOT0001", false, 0)).total).toBe(1);
  reader.clear();
  expect((await reader.collection("ROOT0001", false, 0)).total).toBe(0);
});
it("reads full abstracts only for explicit or already returned items", async () => {
  fixture();
  const registry = new ToolRegistry({} as any);
  const context = {
    conversationID: "test",
    maxAttachments: 20,
    evidenceBudget: { remainingChars: 60000 },
    context: {
      refs: {
        items: [],
        attachments: [],
        notes: [],
        annotations: [],
        collections: [{ libraryID: 1, key: "ROOT0001" }],
        hasEphemeralSelection: false,
      },
    },
  };
  const read = {
    id: "read",
    name: "read_abstracts",
    arguments: { refs: [{ libraryID: 1, itemKey: "PAPER001" }] },
  };
  expect((await registry.execute(read, context)).ok).toBe(false);
  expect(
    (
      await registry.execute(
        { id: "list", name: "read_collection_items", arguments: {} },
        context,
      )
    ).ok,
  ).toBe(true);
  const result = await registry.execute(read, context);
  expect(result.ok).toBe(true);
  expect((result.content as any).items[0].abstract.length).toBeGreaterThan(240);
  expect(result.sources![0].field).toBe("abstract");
  expect(result.sources![0].snippet).not.toContain("<p>");
});

it("resolves cold collection cache placeholders through exact membership only", async () => {
  const { root } = fixture();
  const condition = vi.fn();
  const item = await Zotero.Items.getByLibraryAndKeyAsync(1, "PAPER001");
  root.getChildItems = () => [false] as any;
  (Zotero.Items as any).getAsync = vi.fn(async () => item);
  (Zotero as any).Search = class {
    libraryID = 1;
    addCondition = condition;
    async search() {
      return [1];
    }
  };
  (root as any).key = "ROOT0001";
  const page = await new DirectReader().collection("ROOT0001", false, 0);
  expect(page.total).toBe(1);
  expect(condition).toHaveBeenCalledExactlyOnceWith("collection", "is", "ROOT0001");
});
it("keeps previous search, PDF and RSS tool menus unchanged", () => {
  const registry = new ToolRegistry({} as any);
  const definitions = registry.definitions();
  const cases: Array<[string, boolean, string]> = [
    ["找两次基因组创新的文章", false, "search-planning"],
    ["搜索集合中的风媒文章", false, "search-planning"],
    ["核查这篇论文的方法", true, "context-inspection"],
    ["总结RSS订阅", false, "feed-reading"],
  ];
  for (const [query, attached, expected] of cases) {
    const state = initialAgentState(query, attached);
    expect(state).toBe(expected);
    expect(
      toolsForAgentState(definitions, state, query).map((entry) => entry.function.name),
    ).not.toContain("read_abstracts");
  }
  expect(initialAgentState("翻译摘要", true, false, false)).toBe("context-inspection");
  expect(initialAgentState("翻译摘要", true)).toBe("direct-reading");
  expect(initialAgentState("总结这个集合", false)).toBe("direct-reading");
});
