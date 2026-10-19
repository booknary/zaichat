/** Zotero 10's legacy singular getter throws even for a single selected row. */
export function selectedCollections(pane: any): Zotero.Collection[] {
  if (typeof pane?.getSelectedCollections === "function")
    return pane.getSelectedCollections();
  const collection = pane?.getSelectedCollection?.();
  return collection ? [collection] : [];
}
