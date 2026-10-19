import { afterEach, expect, it, vi } from "vitest";
import { FeedReader, feedText } from "../src/host/feedReader";
import { ToolRegistry } from "../src/agent/toolRegistry";
import {
  initialAgentState,
  toolsForAgentState,
  transitionAfterTool,
} from "../src/agent/agentState";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const feed = { libraryID: 9, name: "Evolution Ecology", isFeed: true };
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    libraryID: 9,
    key: `FEED${String(i).padStart(4, "0")}`,
    dateAdded: "2026-09-10 12:00:00",
    deleted: false,
    getField: (name: string) =>
      (
        ({
          title: `Feed article ${i}`,
          date: "2020-01-01",
          abstractNote:
            i === 11
              ? ""
              : '<p xmlns:mml="http://www.w3.org/1998/Math/MathML">' +
                "Complete abstract text. ".repeat(30) +
                "</p>",
        }) as Record<string, string>
      )[name],
  }));
  const getAll = vi.fn(async () => items.map((item) => item.id));
  vi.stubGlobal("Zotero", {
    Libraries: { get: (id: number) => (id === 9 ? feed : { isFeed: false }) },
    Feeds: { getAll: () => [feed] },
    Items: {
      loadDataTypes: vi.fn(async () => {}),
      getAll,
      getAsync: async (ids: number[]) => items.filter((item) => ids.includes(item.id)),
      getByLibraryAndKeyAsync: async (_id: number, key: string) =>
        items.find((item) => item.key === key),
    },
  });
  return { getAll, items };
}

it("cleans RSS markup before truncating, preserving abstract text and entities", () => {
  expect(
    feedText(
      '<p xmlns:mml="http://www.w3.org/1998/Math/MathML">A &amp; B &#945; &lt; 1</p><script>bad()</script>',
    ),
  ).toBe("A & B α < 1");
});

it("reads a feed with date filtering and stable paging without searching or refreshing", async () => {
  const { getAll } = fixture();
  const reader = new FeedReader();
  const args = { feedID: 9, dateFrom: "2026-09-01", dateTo: "2026-09-30" };
  expect(reader.list()[0].name).toBe("Evolution Ecology");
  const first = await reader.page(args);
  const second = await reader.page({ ...args, offset: 10 });
  expect(first.totalAvailable).toBe(12);
  expect(first.records).toHaveLength(10);
  expect(second.records).toHaveLength(2);
  expect(second.records[1].abstractMissing).toBe(true);
  expect(first.records[0].abstract.length).toBeGreaterThan(240);
  expect(first.records[0].abstract).not.toContain("xmlns");
  expect((await reader.page({ ...args, dateBasis: "published" })).totalAvailable).toBe(
    0,
  );
  expect(getAll).toHaveBeenCalledWith(9, true, false, true);
  await expect(reader.page({ ...args, feedID: 1 })).rejects.toThrow("feedID");
  await expect(reader.page({ ...args, dateFrom: "bad" })).rejects.toThrow("Dates");
});

it("delivers the selected feed abstract directly and registers citation sources", async () => {
  fixture();
  const getItems = vi.fn();
  const registry = new ToolRegistry({ getItems } as any);
  const context = {
    conversationID: "test",
    maxAttachments: 20,
    evidenceBudget: { remainingChars: 60000 },
    context: {
      refs: {
        items: [{ libraryID: 9, itemKey: "FEED0000" }],
        attachments: [],
        notes: [],
        annotations: [],
        collections: [],
        hasEphemeralSelection: false,
      },
    },
  };
  const result = await registry.execute(
    { id: "read", name: "get_current_context", arguments: {} },
    context,
  );
  expect(result.ok).toBe(true);
  expect((result.content as any).items[0].abstract.length).toBeGreaterThan(240);
  expect(getItems).not.toHaveBeenCalled();
  expect(registry.resolveSources([result.sources![0].sourceID])).toHaveLength(1);
  expect(transitionAfterTool("context-inspection", result)).toBe("feed-reading");
  const state = initialAgentState("总结最近一个月 Evolution Ecology 订阅", false);
  expect(state).toBe("feed-reading");
  const names = toolsForAgentState(registry.definitions(), state, "订阅").map(
    (t) => t.function.name,
  );
  expect(names).toContain("read_feed_items");
  expect(names).not.toContain("plan_search");
  expect(names).not.toContain("search_fulltext");
});

it("advances only delivered feed entries and stops on an exhausted budget", async () => {
  fixture();
  const registry = new ToolRegistry({} as any);
  const context = {
    conversationID: "test",
    maxAttachments: 20,
    evidenceBudget: { remainingChars: 2000 },
    context: {
      refs: {
        items: [],
        attachments: [],
        notes: [],
        annotations: [],
        collections: [],
        hasEphemeralSelection: false,
      },
    },
  };
  const result = await registry.execute(
    {
      id: "read",
      name: "read_feed_items",
      arguments: { feedID: 9, dateFrom: "2026-09-01", dateTo: "2026-09-30" },
    },
    context,
  );
  expect(result.ok).toBe(true);
  expect((result.content as any).nextOffset).toBe(result.resultCount);
  expect(result.resultCount).toBeGreaterThan(0);
  context.evidenceBudget.remainingChars = 0;
  const empty = await registry.execute(
    {
      id: "empty",
      name: "read_feed_items",
      arguments: { feedID: 9, dateFrom: "2026-09-01", dateTo: "2026-09-30" },
    },
    context,
  );
  expect((empty.content as any).nextOffset).toBeNull();
  expect((empty.content as any).remainingItems).toBe(12);
});

it("loads cold item fields and isolates a broken item without skipping the page", async () => {
  const { items } = fixture();
  let loaded = false;
  const original = items[0].getField;
  items[0].getField = (field) => {
    if (!loaded) throw new Error("UnloadedDataException");
    return original(field);
  };
  (Zotero.Items.loadDataTypes as any).mockImplementation(async (entries: any[]) => {
    if (entries[0] === items[1]) throw new Error("Broken field data");
    loaded = true;
  });
  const records = await new FeedReader().records(
    items.slice(0, 3).map((item) => ({ libraryID: 9, itemKey: item.key })),
  );
  expect(records).toHaveLength(3);
  expect(records[0].abstract).toContain("Complete abstract");
  expect(records[1].readError).toBeTruthy();
  expect(records[1].abstractMissing).toBe(false);
  expect(records[2].abstract).toContain("Complete abstract");
});

it("accepts a verified empty range and rejects silent date expansion until a new run", async () => {
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
        collections: [],
        hasEphemeralSelection: false,
      },
    },
  };
  const call = {
    id: "read",
    name: "read_feed_items",
    arguments: { feedID: 9, dateFrom: "2025-01-01", dateTo: "2025-01-31" },
  };
  expect((await registry.execute(call, context)).ok).toBe(true);
  const finish = await registry.execute(
    {
      id: "finish",
      name: "finish_answer",
      arguments: {
        answer: "No cached entries in this interval.",
        sourceIDs: [],
        evidenceInsufficient: false,
      },
    },
    context,
  );
  expect(finish.ok).toBe(true);
  const wider = { ...call, arguments: { ...call.arguments, days: 366 } };
  expect((await registry.execute(wider, context)).ok).toBe(false);
  registry.clearSources();
  expect((await registry.execute(wider, context)).ok).toBe(true);
});
