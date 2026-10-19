import { afterEach, expect, it, vi } from "vitest";
import { authorEvidence } from "../src/agent/authorEvidence";
import { DirectReader } from "../src/host/directReader";
import { ToolRegistry } from "../src/agent/toolRegistry";
import { toolsForAgentState, transitionAfterTool } from "../src/agent/agentState";

afterEach(() => vi.unstubAllGlobals());
it("does not match a surname against an unrelated given-name initial", () => {
  const names = ["Anna S. Carter", "Daniel Example", "D. Example", "Pamela Example"];
  expect(authorEvidence(names, "Example").authors).toEqual(names.slice(1));
  expect(authorEvidence(names, "Smith").authors).toEqual([]);
  expect(authorEvidence(["Example Carter"], "Example").authors).toEqual([]);
  expect(authorEvidence(names, "Daniel Example").authors).toEqual(names.slice(1, 3));
  expect(authorEvidence(names, "Example, Daniel").authors).toEqual(names.slice(1, 3));
});
it("direct author lookup checks complete author fields, OR/AND, deletion and library scope", async () => {
  const field = vi.fn((name: string) => (name === "title" ? "Synthetic" : "2026"));
  const item = (id: number, names: string[]) => ({
    id,
    libraryID: 1,
    key: `PAPER00${id}`,
    isRegularItem: () => true,
    getField: field,
    getCreators: () =>
      names.map((lastName) => ({ firstName: "", lastName, creatorTypeID: 1 })),
  });
  const entries = [
    item(1, ["Daniel Example", "Pamela Example"]),
    item(2, ["Daniel Example"]),
    item(3, ["Anna E. Carter"]),
    { ...item(4, ["Daniel Example"]), deleted: true },
    { ...item(5, ["Daniel Example"]), libraryID: 2 },
  ];
  vi.stubGlobal("Zotero", {
    Libraries: { userLibraryID: 1 },
    CreatorTypes: { getID: () => 1 },
    Search: class {
      addCondition() {}
      async search() {
        return [1, 2, 3, 4, 5];
      }
    },
    Items: { getAsync: async (id: number) => entries[id - 1], loadDataTypes: vi.fn() },
  });
  const reader = new DirectReader();
  expect(
    (await reader.authors(["Daniel Example", "Pamela Example"], "any", 0)).total,
  ).toBe(2);
  expect(
    (await reader.authors(["Daniel Example", "Pamela Example"], "all", 0)).total,
  ).toBe(1);
  expect((await reader.authors(["Example"], "any", 1)).records).toHaveLength(1);
  expect(field).not.toHaveBeenCalledWith("abstractNote");
  const registry = new ToolRegistry({} as any);
  expect(
    toolsForAgentState(registry.definitions(), "search-planning", "author lookup").some(
      (t) => t.function.name === "search_authors",
    ),
  ).toBe(true);
  const result = await registry.execute(
    {
      id: "a",
      name: "search_authors",
      arguments: { names: ["Example"], match: "any" },
    },
    { evidenceBudget: { remainingChars: 60000 } } as any,
  );
  expect(result.ok).toBe(true);
  expect(result.sources).toHaveLength(2);
  expect(transitionAfterTool("search-planning", result)).toBe("evidence-ready");
});
it("resolves only the named previous paper before applying the eight-paper read limit", async () => {
  const getItems = vi.fn(async () => ({ items: [], sources: [] }));
  const registry = new ToolRegistry({ getItems } as any);
  const previousItems = Array.from({ length: 12 }, (_, i) => ({
    libraryID: 1,
    itemKey: `KEY${i}`,
    title: `Paper ${i}`,
  }));
  (registry as any).feeds.isFeed = () => false;
  const result = await registry.execute(
    {
      id: "c",
      name: "get_current_context",
      arguments: { includePrevious: true, title: "Paper 11" },
    },
    {
      previousItems,
      context: {
        refs: {
          items: [],
          attachments: [],
          notes: [],
          annotations: [],
          collections: [],
          selections: [],
        },
      },
      evidenceBudget: { remainingChars: 60000 },
    } as any,
  );
  expect(result.ok).toBe(true);
  expect(getItems).toHaveBeenCalledWith([previousItems[11]]);
  previousItems[11].title = "A synthetic extended article title";
  getItems.mockClear();
  const selected = { libraryID: 1, itemKey: previousItems[11].itemKey };
  const auto = await registry.execute(
    { id: "auto", name: "get_current_context", arguments: { includePrevious: true } },
    {
      userQuery: `${previousItems[11].title} 这篇文章的方法是什么？`,
      previousItems,
      context: {
        refs: {
          items: [selected],
          attachments: [],
          notes: [],
          annotations: [],
          collections: [],
          selections: [],
        },
      },
      evidenceBudget: { remainingChars: 60000 },
    } as any,
  );
  expect(auto.ok).toBe(true);
  expect(getItems).toHaveBeenCalledWith([previousItems[11]]);
});
