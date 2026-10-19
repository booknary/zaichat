import { afterEach, describe, expect, it, vi } from "vitest";
import { locateSourceInCollection } from "../src/host/locateSource";

const previous = (globalThis as any).Zotero;
afterEach(() => {
  (globalThis as any).Zotero = previous;
});

describe("collection-first Locate", () => {
  it("retains Zotero 10's multi-collection view without invoking its removed getter", async () => {
    const legacy = vi.fn(() => {
      throw new Error("Use getSelectedCollections()");
    });
    const selectByID = vi.fn();
    const pane = {
      getSelectedCollection: legacy,
      getSelectedCollections: () => [{ libraryID: 2 }, { libraryID: 1 }],
      collectionsView: { selectByID },
      itemsView: { waitForLoad: async () => {}, selectItems: async () => 1 },
      selectItems: vi.fn(async () => true),
    };
    (globalThis as any).Zotero = {
      Items: {
        getByLibraryAndKey: () => ({ id: 10, libraryID: 1, getCollections: () => [3] }),
      },
    };
    await locateSourceInCollection(
      { ZoteroPane: pane },
      { sourceID: "s", label: "paper", item: { libraryID: 1, itemKey: "ITEM0001" } },
    );
    expect(legacy).not.toHaveBeenCalled();
    expect(selectByID).not.toHaveBeenCalled();
    expect(pane.selectItems).toHaveBeenCalledWith([10], { inLibraryRoot: false });
  });

  it.each([
    { current: true, collections: [3, 2], expected: [], root: false },
    { current: false, collections: [3, 2], expected: ["C2"], root: false },
    { current: false, collections: [], expected: [], root: true },
  ])(
    "selects current, another collection, then root: $expected",
    async ({ current, collections, expected, root }) => {
      let selectedCollection = current ? 9 : 0;
      const selectByID = vi.fn(async (id: string) => {
        selectedCollection = Number(id.slice(1));
        return true;
      });
      const pane = {
        getSelectedCollection: () => (current ? { id: 9, libraryID: 1 } : undefined),
        collectionsView: { selectByID },
        itemsView: {
          waitForLoad: async () => {},
          selectItems: async () => (selectedCollection ? 1 : 0),
        },
        selectItems: vi.fn(async () => true),
      };
      (globalThis as any).Zotero = {
        Items: {
          getByLibraryAndKey: () => ({
            id: 10,
            libraryID: 1,
            getCollections: () => collections,
          }),
        },
        Collections: { get: (id: number) => ({ id, libraryID: 1 }) },
      };
      await locateSourceInCollection(
        { ZoteroPane: pane },
        { sourceID: "s", label: "paper", item: { libraryID: 1, itemKey: "ITEM0001" } },
      );
      expect(selectByID.mock.calls.map(([id]) => id)).toEqual(expected);
      expect(pane.selectItems).toHaveBeenCalledWith([10], { inLibraryRoot: root });
    },
  );
});
