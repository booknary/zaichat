import { sha256Hex } from "./fingerprint";
import {
  PAPER_NAMESPACE,
  PaperSemanticSource,
  PaperSourceField,
  PreparedSemanticRecord,
} from "./types";

const BUILDER_SCHEMA = "paper-record-v1";

export class SemanticRecordBuilder {
  async buildPaper(source: PaperSemanticSource): Promise<PreparedSemanticRecord[]> {
    validateSource(source);
    const fields: Array<{ field: PaperSourceField; value: string }> = [
      { field: "title", value: normalizeText(source.title) },
      { field: "abstract", value: normalizeText(source.abstract) },
      { field: "tags", value: normalizeTags(source.tags).join("; ") },
    ];
    const records: PreparedSemanticRecord[] = [];
    for (const { field, value } of fields) {
      if (!value) continue;
      records.push({
        namespace: PAPER_NAMESPACE,
        recordID: `${PAPER_NAMESPACE}:${source.libraryID}:${source.itemKey}:${field}`,
        recordType: "paper-metadata",
        sourceType:
          field === "abstract" && source.abstractSource === "openalex"
            ? "openalex-work"
            : "zotero-item",
        sourceField: field,
        libraryID: source.libraryID,
        itemKey: source.itemKey,
        sourceHash: await sha256Hex(`${BUILDER_SCHEMA}\u0000${field}\u0000${value}`),
        embeddingText: `${fieldLabel(field)}: ${value}`,
      });
    }
    return records;
  }
}

function validateSource(source: PaperSemanticSource): void {
  if (!Number.isInteger(source.libraryID) || source.libraryID <= 0)
    throw new Error("Paper semantic source requires a positive library ID");
  if (!source.itemKey.trim())
    throw new Error("Paper semantic source requires an item key");
}

function normalizeText(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTags(tags: string[]): string[] {
  const values = new Map<string, string>();
  for (const tag of tags) {
    const normalized = normalizeText(tag);
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (!values.has(key)) values.set(key, normalized);
  }
  return [...values.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value);
}

function fieldLabel(field: PaperSourceField): string {
  if (field === "title") return "Title";
  if (field === "abstract") return "Abstract";
  return "Tags";
}
