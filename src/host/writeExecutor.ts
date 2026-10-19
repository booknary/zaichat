import {
  PendingWriteBatch,
  WriteOperationRecord,
  WriteProposal,
  ZoteroObjectRef,
} from "../core/types";
import { isRegularItem } from "./itemTypes";
import { createID, nowISO } from "../utils/ids";
import { sanitizeNoteHTML, sanitizeTag } from "../utils/sanitize";

export class WriteExecutor {
  async execute(
    batch: PendingWriteBatch,
    selectedProposalIDs?: string[],
  ): Promise<WriteOperationRecord> {
    if (batch.status !== "pending") throw new Error("Write batch is no longer pending");
    const proposals = batch.proposals.filter(
      (proposal) => !selectedProposalIDs || selectedProposalIDs.includes(proposal.id),
    );
    if (!proposals.length) throw new Error("No write proposals selected");
    const record: WriteOperationRecord = {
      id: createID("write"),
      batchID: batch.id,
      executedAt: nowISO(),
      status: "executed",
      changes: [],
    };
    await Zotero.DB.executeTransaction(async () => {
      for (const proposal of proposals)
        record.changes.push(await this.executeProposal(proposal));
    });
    batch.status = "executed";
    return record;
  }

  reject(batch: PendingWriteBatch): void {
    if (batch.status !== "pending") throw new Error("Write batch is no longer pending");
    batch.status = "rejected";
  }

  async undo(record: WriteOperationRecord): Promise<void> {
    if (record.status !== "executed") throw new Error("Operation cannot be undone");
    // Validate the whole batch before making any change so conflicts reject
    // the entire undo operation.
    for (const change of record.changes) {
      const item = resolve(change.target);
      if (!item || item.version !== change.afterVersion) {
        record.status = "conflict";
        throw new Error(`Undo conflict for ${change.target.itemKey}`);
      }
    }
    await Zotero.DB.executeTransaction(async () => {
      for (const change of record.changes) {
        const item = resolve(change.target) as Zotero.Item;
        for (const created of change.created || []) {
          const createdItem = resolve(created);
          if (createdItem) await Zotero.Items.trashTx(createdItem.id);
        }
        for (const tag of change.addedTags || []) item.removeTag(tag);
        for (const related of change.related || []) {
          const target = resolve(related);
          if (target) {
            await item.removeRelatedItem(target);
            await target.removeRelatedItem(item);
            await target.save();
          }
        }
        if ((change.addedTags?.length || change.related?.length) && item)
          await item.save();
      }
    });
    record.status = "undone";
  }

  private async executeProposal(
    proposal: WriteProposal,
  ): Promise<WriteOperationRecord["changes"][number]> {
    if (proposal.kind === "relate-items") {
      const source = assertWritable(proposal.source);
      const targets = proposal.targets
        .map(assertWritable)
        .filter((item) => item.id !== source.id);
      const beforeVersion = source.version;
      const related: ZoteroObjectRef[] = [];
      for (const target of targets) {
        if (!isRelated(source, target)) {
          source.addRelatedItem(target);
          target.addRelatedItem(source);
          await target.save();
          related.push(ref(target));
        }
      }
      if (related.length) await source.save();
      return {
        kind: proposal.kind,
        target: ref(source),
        beforeVersion,
        afterVersion: source.version,
        related,
      };
    }
    const target = assertWritable(proposal.target);
    const beforeVersion = target.version;
    if (proposal.kind === "create-note") {
      const note = new Zotero.Item("note");
      note.libraryID = target.libraryID;
      (note as any).parentItemID = target.id;
      (note as any).setNote(sanitizeNoteHTML(proposal.html));
      await note.save();
      return {
        kind: proposal.kind,
        target: ref(target),
        beforeVersion,
        afterVersion: target.version,
        created: [ref(note)],
      };
    }
    const existing = new Set(
      (target.getTags?.() || []).map((tag: any) => String(tag.tag)),
    );
    const addedTags = proposal.tags
      .map(sanitizeTag)
      .filter(Boolean)
      .filter((tag) => !existing.has(tag!)) as string[];
    for (const tag of addedTags) target.addTag(tag);
    if (addedTags.length) await target.save();
    return {
      kind: proposal.kind,
      target: ref(target),
      beforeVersion,
      afterVersion: target.version,
      addedTags,
    };
  }
}

function assertWritable(reference: ZoteroObjectRef): Zotero.Item {
  const item = resolve(reference);
  if (
    !item ||
    item.libraryID !== Zotero.Libraries.userLibraryID ||
    !isRegularItem(item)
  )
    throw new Error(`Item is not writable: ${reference.itemKey}`);
  return item;
}
function resolve(reference: ZoteroObjectRef): Zotero.Item | false {
  return Zotero.Items.getByLibraryAndKey(reference.libraryID, reference.itemKey);
}
function ref(item: Zotero.Item): ZoteroObjectRef {
  return {
    libraryID: item.libraryID,
    itemKey: item.key,
    title: String(item.getField("title" as any, false, true) || ""),
  };
}
function isRelated(source: Zotero.Item, target: Zotero.Item): boolean {
  return ((source as any).relatedItems || []).some(
    (entry: any) =>
      entry === target.id ||
      entry === target.key ||
      entry?.id === target.id ||
      entry?.key === target.key,
  );
}
