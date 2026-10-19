import { isRegularItem } from "../host/itemTypes";
import {
  PaperSemanticRef,
  PaperSemanticSource,
  PaperSemanticSourceProvider,
} from "./types";
import { PaperAbstractEnricher } from "./openAlexAbstractEnricher";

export class ZoteroPaperSourceProvider implements PaperSemanticSourceProvider {
  constructor(private readonly abstractEnricher?: PaperAbstractEnricher) {}

  async listPapers(): Promise<PaperSemanticSource[]> {
    const libraryID = Zotero.Libraries.userLibraryID;
    const items = await Zotero.Items.getAll(libraryID, true, false);
    return items
      .filter(
        (item) =>
          item.libraryID === libraryID && isRegularItem(item) && !(item as any).deleted,
      )
      .map(toPaperSource);
  }

  async listPaperRefs(): Promise<PaperSemanticRef[]> {
    const libraryID = Zotero.Libraries.userLibraryID;
    const items = await Zotero.Items.getAll(libraryID, true, false);
    return items
      .filter(
        (item) =>
          item.libraryID === libraryID && isRegularItem(item) && !(item as any).deleted,
      )
      .map(({ libraryID: itemLibraryID, key: itemKey }) => ({
        libraryID: itemLibraryID,
        itemKey,
      }));
  }

  async getPaper(
    libraryID: number,
    itemKey: string,
  ): Promise<PaperSemanticSource | null> {
    if (libraryID !== Zotero.Libraries.userLibraryID) return null;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
    if (!item || !isRegularItem(item) || (item as any).deleted) return null;
    const source = toPaperSource(item);
    return this.abstractEnricher?.enrich(source) || source;
  }

  async getPaperRefByItemID(itemID: number): Promise<PaperSemanticRef | null> {
    const item = await Zotero.Items.getAsync(itemID);
    if (
      !item ||
      item.libraryID !== Zotero.Libraries.userLibraryID ||
      !isRegularItem(item)
    )
      return null;
    return { libraryID: item.libraryID, itemKey: item.key };
  }

  async prepareForIndexing(): Promise<void> {
    if (!this.abstractEnricher) return;
    await this.abstractEnricher.prefetch(await this.listPapers());
  }
}

function toPaperSource(item: Zotero.Item): PaperSemanticSource {
  const get = (field: string) => String(item.getField(field as any, false, true) || "");
  return {
    libraryID: item.libraryID,
    itemKey: item.key,
    title: get("title") || String((item as any).getDisplayTitle?.() || ""),
    abstract: get("abstractNote"),
    abstractSource: get("abstractNote") ? "zotero" : undefined,
    doi: get("DOI"),
    tags: (item.getTags?.() || [])
      .map((tag: any) => String(tag.tag || ""))
      .filter(Boolean),
  };
}
