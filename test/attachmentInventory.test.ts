import { afterEach, expect, it, vi } from "vitest";
import { ZoteroRetriever } from "../src/host/zoteroRetriever";
import { ToolRegistry } from "../src/agent/toolRegistry";
afterEach(() => vi.unstubAllGlobals());
it("lists all child files separately from cache readability, with bounded pages", async () => {
  const parent = {
    libraryID: 1,
    key: "PAPER001",
    isRegularItem: () => true,
    getAttachments: () => [1, 2, 3],
  };
  const titles = ["Main paper", "Supplementary Information", "Additional tables"];
  const items = titles.map((title, index) => ({
    id: index + 1,
    libraryID: 1,
    key: `FILE000${index + 1}`,
    itemTypeID: 2,
    getField: () => title,
    attachmentContentType: index === 2 ? "application/zip" : "application/pdf",
  }));
  vi.stubGlobal("Zotero", {
    Items: {
      getByLibraryAndKeyAsync: async () => parent,
      getAsync: async (id: number) => items[id - 1],
      loadDataTypes: vi.fn(),
    },
    ItemTypes: { getName: () => "attachment" },
    Fulltext: { getItemCacheFile: (item: any) => ({ path: `${item.id}` }) },
  });
  vi.stubGlobal("IOUtils", { exists: async (path: string) => path === "1" });
  const page = await new ZoteroRetriever().listAttachments({
    libraryID: 1,
    itemKey: parent.key,
  });
  expect(page.totalAvailable).toBe(3);
  expect(page.items.map((item) => item.state)).toEqual([
    "cache-available-not-read",
    "cache-missing",
    "unsupported-format",
  ]);
  expect(page.items[1].roleHint).toBe("possible-supplement");
  expect(page.items[0].roleHint).toBe("unclassified");
  parent.getAttachments = () => Array(22).fill(1);
  expect(
    (await new ZoteroRetriever().listAttachments({ libraryID: 1, itemKey: parent.key }))
      .nextOffset,
  ).toBe(20);
});
it("authorizes inventory attachments for later reads and returns actionable invalid-reference errors", async () => {
  const parent = { libraryID: 1, itemKey: "PAPER001" };
  const attachment = { libraryID: 1, itemKey: "SUPP0001", title: "Supplement" };
  const readSnippets = vi.fn(async () => []);
  const registry = new ToolRegistry({
    listAttachments: async () => ({
      items: [{ attachment, state: "cache-available-not-read" }],
      totalAvailable: 1,
      offset: 0,
      nextOffset: null,
    }),
    readSnippets,
  } as any);
  const context: any = {
    context: { refs: { items: [parent], attachments: [] } },
    evidenceBudget: { remainingChars: 60000 },
    maxAttachments: 8,
  };
  expect(
    (
      await registry.execute(
        { id: "a", name: "list_attachments", arguments: { ref: parent } },
        context,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await registry.execute(
        {
          id: "b",
          name: "read_attachment_snippets",
          arguments: { attachments: [attachment], terms: ["methods"] },
        },
        context,
      )
    ).ok,
  ).toBe(true);
  expect(readSnippets.mock.calls.length).toBe(1);
  const failure = await registry.execute(
    {
      id: "c",
      name: "read_abstracts",
      arguments: { refs: [{ libraryID: 1, itemKey: "bad-placeholder" }] },
    },
    context,
  );
  expect(failure.ok).toBe(false);
  expect((failure.content as any).invalidRefs[0].itemKey).toBe("bad-placeholder");
  expect((failure.content as any).availableRefs).toEqual([parent]);
});
