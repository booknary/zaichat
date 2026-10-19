import { FeedReader } from "../src/host/feedReader";

describe("RSS metadata reading", function () {
  it("reads a real isolated feed item abstract without indexing or network refresh", async function () {
    this.timeout(30000);
    const feed = new (Zotero as any).Feed({
      name: "ZaiChat isolated RSS",
      url: "https://example.invalid/zaichat-rss-test",
      refreshInterval: 24,
    });
    let saved = false;
    try {
      // Reading a displayed RSS item can independently mark it read in Zotero.
      // Keep this API-only regression in My Library, away from the feed view.
      const pane = Zotero.getMainWindow().ZoteroPane;
      await pane.collectionsView.selectByID(`L${Zotero.Libraries.userLibraryID}`);
      await pane.itemsView.waitForLoad();
      await feed.saveTx();
      saved = true;
      const item = new (Zotero as any).FeedItem("journalArticle");
      item.libraryID = feed.libraryID;
      item.guid = "zaichat-isolated-feed-abstract";
      item.setField("title", "Synthetic RSS article");
      item.setField(
        "abstractNote",
        '<p xmlns:mml="http://www.w3.org/1998/Math/MathML">' +
          "Full abstract content. ".repeat(30) +
          "</p>",
      );
      await item.saveTx();
      await pane.collectionsView.selectByID(`L${Zotero.Libraries.userLibraryID}`);
      await pane.itemsView.waitForLoad();
      // Force the same cold-cache path as a feed the user has not opened.
      Zotero.Items.unload(item.id);
      const before = await Zotero.Items.getAsync(item.id);
      // Establish an explicit unread precondition instead of depending on host
      // feed-import/UI defaults. The tool must preserve it through a cold load.
      await (before as any).toggleRead(false);
      if ((before as any).isRead)
        throw new Error("RSS fixture must be unread before the API-only operation");
      Zotero.Items.unload(item.id);
      const reader = new FeedReader();
      const page = await reader.page({ feedID: feed.libraryID, days: 30 });
      if (
        page.records.length !== 1 ||
        page.records[0].abstract.length < 500 ||
        page.records[0].abstract.includes("xmlns")
      )
        throw new Error("RSS abstract was missing or truncated as a search preview");
      if (((await Zotero.Items.getAsync(item.id)) as any).isRead)
        throw new Error("Read-only RSS tool changed read status");
    } catch (error) {
      throw {
        message: "RSS integration failed",
        actual: String(error),
        expected: "Full cached abstract",
      };
    } finally {
      if (saved) await feed.eraseTx();
    }
  });
});
