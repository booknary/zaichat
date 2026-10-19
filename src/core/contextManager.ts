import { ContextEnvelope, MessageContextRefs, ZoteroObjectRef } from "./types";
import { ZoteroRetriever } from "../host/zoteroRetriever";
import { isAnnotationItem, isAttachmentItem, isNoteItem } from "../host/itemTypes";
import { selectedCollections } from "../host/collectionSelection";
import { hostMenuText } from "../host/uiLocale";

export interface AvailableContext {
  id: string;
  label: string;
  kind: "item" | "attachment" | "note" | "annotation" | "collection" | "selection";
  ref?: ZoteroObjectRef;
  collection?: { libraryID: number; key: string; name?: string };
  ephemeralText?: string;
}

export class ContextManager {
  constructor(private readonly retriever: ZoteroRetriever) {}

  getAvailable(win: _ZoteroTypes.MainWindow): AvailableContext[] {
    const t = hostMenuText();
    const available: AvailableContext[] = [];
    const pane = (win as any).ZoteroPane;
    const selected = (pane?.getSelectedItems?.() || []) as Zotero.Item[];
    for (const item of selected.slice(0, 20))
      available.push({
        id: `item:${item.libraryID}:${item.key}`,
        label: String(
          item.getField("title" as any, false, true) ||
            (item as any).getDisplayTitle?.() ||
            item.key,
        ),
        kind: isAttachmentItem(item)
          ? "attachment"
          : isNoteItem(item)
            ? "note"
            : isAnnotationItem(item)
              ? "annotation"
              : "item",
        ref: this.retriever.ref(item),
      });
    for (const collection of selectedCollections(pane))
      available.push({
        id: `collection:${collection.libraryID}:${collection.key}`,
        label: collection.name,
        kind: "collection",
        collection: {
          libraryID: collection.libraryID,
          key: collection.key,
          name: collection.name,
        },
      });
    const reader = (Zotero.Reader as any).getByTabID?.(
      (win as any).Zotero_Tabs?.selectedID,
    );
    const attachmentID = Number(reader?.itemID || 0);
    const attachment = attachmentID ? Zotero.Items.get(attachmentID) : undefined;
    if (attachment)
      available.push({
        id: `reader:${attachment.libraryID}:${attachment.key}`,
        label: t("Reading: {title}", {
          title: String(
            attachment.getField("title" as any, false, true) || attachment.key,
          ),
        }),
        kind: "attachment",
        ref: this.retriever.ref(attachment),
      });
    const selection = safeReaderSelection(reader);
    if (selection)
      available.push({
        id: `selection:${attachment?.key || "reader"}`,
        label: t("Selected text ({count} chars)", { count: selection.length }),
        kind: "selection",
        ephemeralText: selection,
      });
    return dedupe(available);
  }

  build(selected: AvailableContext[]): ContextEnvelope {
    const refs: MessageContextRefs = {
      items: [],
      attachments: [],
      notes: [],
      annotations: [],
      collections: [],
      hasEphemeralSelection: selected.some((entry) => entry.kind === "selection"),
    };
    let ephemeralSelection: string | undefined;
    for (const entry of selected) {
      if (entry.kind === "collection" && entry.collection)
        refs.collections.push(entry.collection);
      else if (entry.kind === "selection")
        ephemeralSelection = entry.ephemeralText?.slice(0, 10000);
      else if (entry.ref)
        refs[
          entry.kind === "attachment"
            ? "attachments"
            : entry.kind === "note"
              ? "notes"
              : entry.kind === "annotation"
                ? "annotations"
                : "items"
        ].push(entry.ref);
    }
    return { refs, ephemeralSelection };
  }
}

function safeReaderSelection(reader: any): string | undefined {
  try {
    const text = String(
      reader?._iframeWindow?.document?.getSelection?.()?.toString?.() || "",
    ).trim();
    return text ? text.slice(0, 10000) : undefined;
  } catch {
    return undefined;
  }
}
function dedupe(entries: AvailableContext[]): AvailableContext[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}
