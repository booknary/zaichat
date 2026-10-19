import { ZoteroRetriever } from "../src/host/zoteroRetriever";
import { normalizeQuery } from "../src/retrieval/ranking";

describe("Exact-title resolution in isolated Zotero", function () {
  it("resolves named papers directly and preserves explicit field filters", async function () {
    this.timeout(30000);
    if (!String(Zotero.Profile.dir).replace(/\\/g, "/").includes("/.scaffold/"))
      throw new Error("Synthetic write test requires the project-isolated profile");
    const paper = new Zotero.Item("journalArticle");
    let saved = false;
    try {
      const title = `Synthetic direct-title verification ${Date.now()}`;
      paper.setField("title", title);
      paper.setField("abstractNote", "We observed an association between two traits.");
      paper.setField("date", "2024");
      await paper.saveTx();
      saved = true;
      let semanticCalls = 0;
      const retriever = new ZoteroRetriever({
        searchPapers: async () => {
          semanticCalls++;
          return [];
        },
      });
      const query = normalizeQuery({
        intent: "known_item",
        required: [["verification"]],
        exactTitles: [title],
      });
      const result = await retriever.searchLibrary(query, `Find 《${title}》`, {
        preferExactTitles: true,
      });
      if (
        !result.discovery.exactTitleResolved ||
        semanticCalls ||
        result.items.length !== 1 ||
        result.items[0].item.itemKey !== paper.key
      )
        throw new Error("Exact title was not resolved directly in host runtime");
      const filtered = await retriever.searchLibrary(
        { ...query, yearMin: 2025 },
        `Find 《${title}》`,
        { preferExactTitles: true, deferFulltext: true },
      );
      if (
        filtered.items.some((row) => row.item.itemKey === paper.key) ||
        filtered.discovery.exactTitleResolved
      )
        throw new Error("Exact-title shortcut bypassed the explicit year filter");
    } finally {
      if (saved) await (await Zotero.Items.getAsync(paper.id)).eraseTx();
    }
  });
});
