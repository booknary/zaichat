import { DirectReader } from "../src/host/directReader";

describe("Direct collection and abstract reads", function () {
  it("loads real collection members and full cached abstracts without search", async function () {
    this.timeout(30000);
    const collection = new Zotero.Collection();
    collection.name = "ZaiChat isolated direct reading";
    const paper = new Zotero.Item("journalArticle");
    let savedCollection = false,
      savedPaper = false;
    let failure: { message: string; actual: string; expected: string } | undefined;
    try {
      await collection.saveTx();
      savedCollection = true;
      paper.setField("title", "Synthetic direct-reading paper");
      paper.setField("abstractNote", "Complete abstract sentence. ".repeat(40));
      paper.setField("publicationTitle", "Synthetic journal");
      paper.setField("DOI", "10.0000/zaichat-test");
      paper.setCreators([
        { firstName: "Ada", lastName: "ZaichatTestSurname", creatorType: "author" },
        { firstName: "Other Z.", lastName: "Unrelated", creatorType: "author" },
      ]);
      paper.addToCollection(collection.id);
      await paper.saveTx();
      savedPaper = true;
      Zotero.Items.unload(paper.id);
      const reader = new DirectReader();
      const authorPage = await reader.authors(["ZaichatTestSurname"], "any", 0);
      if (
        authorPage.total !== 1 ||
        authorPage.records[0].matches[0].authors.length !== 1
      )
        throw new Error("Author-field direct lookup failed");
      const page = await reader.collection(collection.key, false, 0);
      if (
        page.total !== 1 ||
        page.records.length !== 1 ||
        page.records[0].abstract !== undefined
      )
        throw new Error(
          `Collection metadata page failed: ${JSON.stringify({ page, raw: collection.getChildItems(false, false).map((item: any) => ({ type: typeof item, id: item?.id, key: item?.key })) })}`,
        );
      const records = await reader.records([page.records[0].item], true);
      if (
        records[0].publicationTitle !== "Synthetic journal" ||
        records[0].doi !== "10.0000/zaichat-test"
      )
        throw new Error("Journal/DOI metadata was not delivered");
      if (
        !records[0].abstract ||
        records[0].abstract.length < 500 ||
        records[0].abstractTruncated
      )
        throw new Error("Full cached abstract was not delivered");
    } catch (error) {
      failure = {
        message: "Direct read integration failed",
        actual: String(error),
        expected: "One paper and full abstract",
      };
    } finally {
      try {
        if (savedPaper) {
          const fresh = await Zotero.Items.getAsync(paper.id);
          await Zotero.Items.loadDataTypes([fresh], ["collections"]);
          await fresh.eraseTx();
        }
        if (savedCollection) await collection.eraseTx();
      } catch (error) {
        failure = {
          message: "Direct read cleanup failed",
          actual: `${failure ? JSON.stringify(failure) + "; " : ""}${String(error)}`,
          expected: "Isolated test cleanup",
        };
      }
    }
    if (failure) throw failure;
  });
});
