import { locateSourceInCollection } from "../src/host/locateSource";
import { selectedCollections } from "../src/host/collectionSelection";
import { ContextManager } from "../src/core/contextManager";
import { ZoteroRetriever } from "../src/host/zoteroRetriever";

describe("Collection-first source navigation", function () {
  it("retains a current collection and finds another owning collection before library root", async function () {
    this.timeout(30000);
    const win = Zotero.getMainWindow();
    const pane = (win as any).ZoteroPane;
    const collection = new Zotero.Collection();
    collection.name = "ZaiChat isolated Locate test";
    const paper = new Zotero.Item("journalArticle");
    paper.setField("title", "ZaiChat isolated navigation paper");
    try {
      await collection.saveTx();
      paper.setCollections([collection.id]);
      await paper.saveTx();
      const source = {
        sourceID: "test-source",
        label: "test",
        item: { libraryID: paper.libraryID, itemKey: paper.key },
      };
      await pane.collectionsView.selectByID(`L${paper.libraryID}`);
      await locateSourceInCollection(win, source);
      if (selectedCollections(pane)[0]?.id !== collection.id)
        throw new Error("Locate did not choose owning collection");
      await locateSourceInCollection(win, source);
      if (selectedCollections(pane)[0]?.id !== collection.id)
        throw new Error("Locate left current collection");
      if (
        !new ContextManager(new ZoteroRetriever())
          .getAvailable(win)
          .some((entry) => entry.collection?.key === collection.key)
      )
        throw new Error(
          "Selected collection was not available as explicit chat context",
        );
      paper.setCollections([]);
      await paper.saveTx();
      await locateSourceInCollection(win, source);
      if (selectedCollections(pane).length)
        throw new Error("Unfiled paper did not fall back to library");
    } finally {
      if (paper.id) await paper.eraseTx();
      if (collection.id) await collection.eraseTx();
    }
  });
});
