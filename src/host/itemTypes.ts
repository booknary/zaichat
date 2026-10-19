type ZoteroItemLike = Zotero.Item | Record<string, unknown>;

export function isAttachmentItem(item: ZoteroItemLike | undefined): boolean {
  return isItemKind(item, "isAttachment", "attachment");
}

export function isNoteItem(item: ZoteroItemLike | undefined): boolean {
  return isItemKind(item, "isNote", "note");
}

export function isAnnotationItem(item: ZoteroItemLike | undefined): boolean {
  return isItemKind(item, "isAnnotation", "annotation");
}

export function isRegularItem(item: ZoteroItemLike | undefined): boolean {
  const explicit = readPredicate(item, "isRegularItem");
  if (explicit !== undefined) return explicit;
  return (
    Boolean(item) &&
    !isAttachmentItem(item) &&
    !isNoteItem(item) &&
    !isAnnotationItem(item)
  );
}

function isItemKind(
  item: ZoteroItemLike | undefined,
  predicate: string,
  expectedType: string,
): boolean {
  const explicit = readPredicate(item, predicate);
  if (explicit !== undefined) return explicit;
  if (!item) return false;
  const record = item as Record<string, unknown>;
  const directType = String(record.itemType || record.itemTypeName || "").toLowerCase();
  if (directType) return directType === expectedType;
  const itemTypeID = Number(record.itemTypeID || 0);
  const zotero = (globalThis as any).Zotero;
  if (!itemTypeID || typeof zotero?.ItemTypes?.getName !== "function") return false;
  return String(zotero.ItemTypes.getName(itemTypeID)).toLowerCase() === expectedType;
}

function readPredicate(
  item: ZoteroItemLike | undefined,
  name: string,
): boolean | undefined {
  if (!item) return undefined;
  const value = (item as Record<string, unknown>)[name];
  if (typeof value === "boolean") return value;
  if (typeof value !== "function") return undefined;
  return Boolean(value.call(item));
}
