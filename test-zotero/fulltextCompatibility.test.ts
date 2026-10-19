import { ZoteroRetriever } from "../src/host/zoteroRetriever";
import { normalizeQuery } from "../src/retrieval/ranking";

describe("Host fulltext compatibility", function () {
  it("recalls an indexed attachment's parent and reads its bounded text cache", async function () {
    this.timeout(30000);
    const profile = String(Zotero.Profile.dir);
    if (!profile.replace(/\\/g, "/").includes("/.scaffold/"))
      throw new Error("Synthetic indexing requires the project-isolated profile");
    const token = `zaichatcompatibility${Date.now()}`;
    const input = PathUtils.join(profile, `${token}.html`);
    const paper = new Zotero.Item("journalArticle");
    let saved = false;
    try {
      await IOUtils.writeUTF8(
        input,
        `<html><head><title>Synthetic fixture</title></head><body><p>Observed ${token} in a synthetic compatibility fixture.</p></body></html>`,
      );
      paper.setField("title", "Synthetic indexed-attachment compatibility paper");
      await paper.saveTx();
      saved = true;
      const attachment = await Zotero.Attachments.importFromFile({
        file: input,
        parentItemID: paper.id,
      });
      await Zotero.Fulltext.indexItems([attachment.id], { complete: true });
      const retriever = new ZoteroRetriever();
      const found = await retriever.searchLibrary(
        normalizeQuery({ required: [[token]] }),
        token,
      );
      if (
        !found.items.some((row) => row.item.itemKey === paper.key) ||
        !found.discovery.fulltextCandidates
      )
        throw new Error(
          "Native indexed-fulltext discovery did not return the fixture's parent paper",
        );
      const snippets = await retriever.readSnippets(
        [{ libraryID: attachment.libraryID, itemKey: attachment.key }],
        [token],
        1,
        1,
        800,
      );
      if (!snippets.length || !snippets[0].text.includes(token))
        throw new Error("Bounded reading could not read the host's fulltext cache");
      const inventory = await retriever.listAttachments({
        libraryID: paper.libraryID,
        itemKey: paper.key,
      });
      if (
        !inventory.items.some(
          (row) =>
            row.attachment.itemKey === attachment.key &&
            row.state === "cache-available-not-read",
        )
      )
        throw new Error("Attachment inventory did not recognize the existing cache");
    } finally {
      if (saved) {
        const fresh = await Zotero.Items.getAsync(paper.id);
        await Zotero.Items.loadDataTypes([fresh], ["childItems"]);
        await fresh.eraseTx();
      }
      await IOUtils.remove(input, { ignoreAbsent: true });
    }
  });
});
