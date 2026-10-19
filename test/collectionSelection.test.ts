import { afterEach, expect, it, vi } from "vitest";
import { selectedCollections } from "../src/host/collectionSelection";
import { ContextManager } from "../src/core/contextManager";
import manifest from "../addon/manifest.json";

afterEach(() => vi.unstubAllGlobals());

it("declares bounded Zotero 9 and 10.0 compatibility", () => {
  expect(manifest.applications.zotero.strict_min_version).toBe("9.0");
  expect(manifest.applications.zotero.strict_max_version).toBe("10.0.*");
});

it.each([
  { collections: [] },
  { collections: [{ libraryID: 1, key: "COLL0001", name: "One" }] },
  {
    collections: [
      { libraryID: 1, key: "COLL0001", name: "One" },
      { libraryID: 1, key: "COLL0002", name: "Two" },
    ],
  },
])(
  "uses plural selection without calling the removed getter: $collections",
  ({ collections }) => {
    const legacy = vi.fn(() => {
      throw new Error("Use getSelectedCollections()");
    });
    const pane = {
      getSelectedCollections: () => collections,
      getSelectedCollection: legacy,
    };
    expect(selectedCollections(pane)).toEqual(collections);
    expect(legacy).not.toHaveBeenCalled();
  },
);

it("keeps Zotero 9 single-selection and empty-selection behavior", () => {
  const collection = { libraryID: 1, key: "COLL0001" };
  expect(selectedCollections({ getSelectedCollection: () => collection })).toEqual([
    collection,
  ]);
  expect(selectedCollections({ getSelectedCollection: () => false })).toEqual([]);
  expect(selectedCollections(undefined)).toEqual([]);
});

it("offers all selected collections as explicit attachments, not automatic context", () => {
  const collections = [
    { libraryID: 1, key: "COLL0001", name: "One" },
    { libraryID: 1, key: "COLL0002", name: "Two" },
  ];
  vi.stubGlobal("Zotero", { Reader: { getByTabID: () => undefined } });
  const manager = new ContextManager({} as any);
  const available = manager.getAvailable({
    ZoteroPane: {
      getSelectedItems: () => [],
      getSelectedCollections: () => collections,
      getSelectedCollection: () => {
        throw new Error("Removed singular getter");
      },
    },
  } as any);
  expect(available.map((entry) => entry.collection)).toEqual(
    collections.map(({ libraryID, key, name }) => ({ libraryID, key, name })),
  );
  expect(manager.build([]).refs.collections).toEqual([]);
  expect(manager.build(available).refs.collections).toHaveLength(2);
});
