import type { SourceReference } from "../core/types";
import { selectedCollections } from "./collectionSelection";

export async function locateSourceInCollection(
  win: any,
  source: SourceReference,
): Promise<void> {
  let item = Zotero.Items.getByLibraryAndKey(
    source.item.libraryID,
    source.item.itemKey,
  );
  if (!item) throw new Error("The source item no longer exists.");
  if (item.parentItem) item = item.parentItem;
  const pane = win.ZoteroPane;
  if (!pane?.collectionsView) throw new Error("Zotero library view is not ready.");
  const tree = pane.collectionsView;
  const current = selectedCollections(pane);
  const selectHere = async () => {
    await pane.itemsView?.waitForLoad();
    return (await pane.itemsView?.selectItems([item.id])) === 1;
  };
  // Also retains a parent collection when recursive collection display is enabled.
  let selected = Boolean(
    current.some((collection) => collection.libraryID === item.libraryID) &&
    (await selectHere()),
  );
  if (!selected) {
    const ids = [...item.getCollections()].sort((a, b) => a - b);
    for (const id of ids) {
      const collection = Zotero.Collections.get(id);
      if (!collection || collection.libraryID !== item.libraryID) continue;
      if ((await tree.selectByID(`C${id}`)) && (await selectHere())) {
        selected = true;
        break;
      }
    }
  }
  // Use the host's normal final selection for focus/tab restoration and trash handling.
  await pane.selectItems([item.id], { inLibraryRoot: !selected });
}
