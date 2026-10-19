import { ZoteroRetriever } from "../src/host/zoteroRetriever";

describe("Annotated-paper metadata regression", function () {
  it("reads real Zotero annotation objects without coercing them to item IDs", async function () {
    this.timeout(30000);
    const paper = new Zotero.Item("journalArticle");
    paper.setField("title", "ZaiChat isolated annotation regression");
    let saved = false;
    let stage = "save parent";
    try {
      await paper.saveTx();
      saved = true;
      stage = "save PDF attachment";
      const attachment = new Zotero.Item("attachment");
      attachment.libraryID = paper.libraryID;
      attachment.parentID = paper.id;
      attachment.attachmentLinkMode = Zotero.Attachments.LINK_MODE_IMPORTED_FILE;
      attachment.attachmentContentType = "application/pdf";
      attachment.attachmentPath = "storage:regression.pdf";
      await attachment.saveTx();
      stage = "save annotation";
      const annotation = new Zotero.Item("annotation");
      annotation.libraryID = paper.libraryID;
      annotation.parentID = attachment.id;
      annotation.annotationType = "highlight";
      annotation.annotationText = "Method Alpha was used in the analysis.";
      annotation.annotationComment = "Synthetic methods evidence";
      annotation.annotationColor = "#ffff00";
      annotation.annotationSortIndex = "00000|000000|00000";
      annotation.annotationPosition = JSON.stringify({
        pageIndex: 0,
        rects: [[1, 1, 10, 10]],
      });
      await annotation.saveTx();
      stage = "read parent metadata";
      const retriever = new ZoteroRetriever();
      const found = await retriever.getItems([
        { libraryID: paper.libraryID, itemKey: paper.key },
      ]);
      if (found.items.length !== 1 || found.items[0].attachmentRefs?.length !== 1)
        throw new Error("Annotated paper metadata or attachment was lost");
      const annotations = await retriever.listAnnotations({
        libraryID: paper.libraryID,
        itemKey: paper.key,
      });
      if (annotations.length !== 1 || !annotations[0].text.includes("Method Alpha"))
        throw new Error("Real annotation object did not resolve");
      if (found.items[0].sourceID !== found.sources[0].sourceID)
        throw new Error("Metadata source identity mismatch");
      const supplement = new Zotero.Item("attachment");
      supplement.libraryID = paper.libraryID;
      supplement.parentID = paper.id;
      supplement.setField("title", "Supplementary Information");
      supplement.attachmentLinkMode = Zotero.Attachments.LINK_MODE_IMPORTED_FILE;
      supplement.attachmentContentType = "application/pdf";
      supplement.attachmentPath = "storage:synthetic-si.pdf";
      await supplement.saveTx();
      const inventory = await retriever.listAttachments({
        libraryID: paper.libraryID,
        itemKey: paper.key,
      });
      if (
        inventory.totalAvailable !== 2 ||
        !inventory.items.some(
          (entry) =>
            entry.attachment.itemKey === supplement.key &&
            entry.roleHint === "possible-supplement" &&
            entry.state === "cache-missing",
        )
      )
        throw new Error("Supplement inventory lost a real child attachment");
    } catch (error) {
      // The scaffold transports enumerable fields; native Error fields are lost.
      throw {
        message: `Annotated-paper test failed during ${stage}`,
        expected: "successful Zotero metadata read",
        actual: `${String(error)} ${(error as any)?.stack || ""}`,
      };
    } finally {
      // Only removes this test's newly created parent and children in the scaffold profile.
      if (saved) await paper.eraseTx();
    }
  });
});
