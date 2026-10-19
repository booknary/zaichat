import { SourceReference, ZoteroObjectRef } from "../core/types";
import { createID } from "../utils/ids";

export function feedText(value: unknown): string {
  return String(value || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, code: string) => {
      if (code.startsWith("#")) {
        const n =
          code[1].toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : Number(code.slice(1));
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
      }
      return (
        { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<
          string,
          string
        >
      )[code.toLowerCase()];
    })
    .replace(/\s+/g, " ")
    .trim();
}

export class FeedReader {
  list() {
    return (Zotero as any).Feeds.getAll().map((feed: any) => ({
      libraryID: feed.libraryID,
      name: String(feed.name),
      lastCheck: feed.lastCheck,
    }));
  }

  isFeed(ref: ZoteroObjectRef): boolean {
    return (
      typeof Zotero !== "undefined" &&
      Boolean((Zotero as any).Libraries?.get?.(ref.libraryID)?.isFeed)
    );
  }

  async records(refs: ZoteroObjectRef[]) {
    const records = [];
    for (const ref of refs) {
      if (!this.isFeed(ref))
        throw new Error("Only RSS feed libraries can be read by this tool");
      let abstract = "",
        title = "",
        publicationDate = "",
        dateAdded = "";
      let readError: string | undefined;
      try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          ref.libraryID,
          ref.itemKey,
        );
        if (!item || item.deleted) throw new Error("Feed item is no longer available");
        await Zotero.Items.loadDataTypes([item], ["itemData"]);
        abstract = feedText(item.getField("abstractNote"));
        title = feedText(item.getField("title"));
        publicationDate = String(item.getField("date") || "");
        dateAdded = item.dateAdded;
      } catch (error) {
        // One unreadable entry must not abort the other articles or look missing.
        readError = error instanceof Error ? error.name : "ReadError";
      }
      const source: SourceReference = {
        sourceID: createID("src"),
        item: ref,
        label: title,
        field: "abstract",
      };
      records.push({
        source,
        sourceID: source.sourceID,
        item: ref,
        title,
        feedName: String((Zotero as any).Libraries.get(ref.libraryID).name),
        sourceType: "feed",
        abstract: abstract.slice(0, 16000),
        abstractMissing: !readError && !abstract,
        readError,
        abstractTruncated: abstract.length > 16000,
        publicationDate,
        dateAdded,
      });
    }
    return records;
  }

  async page(args: Record<string, any>) {
    const feedID = Number(args.feedID);
    if (
      !Number.isSafeInteger(feedID) ||
      !this.isFeed({ libraryID: feedID, itemKey: "" })
    )
      throw new Error("Choose a valid feedID returned by list_feeds");
    const days = args.days === undefined ? 30 : Number(args.days);
    if (!Number.isInteger(days) || days < 1 || days > 366)
      throw new Error("days must be between 1 and 366");
    const dateBasis = args.dateBasis || "added";
    if (!["added", "published"].includes(dateBasis))
      throw new Error("Invalid dateBasis");
    const parseDate = (value: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)))
        throw new Error("Dates must be YYYY-MM-DD");
      return Date.parse(value);
    };
    const end = args.dateTo ? parseDate(args.dateTo) + 86400000 : Date.now() + 1;
    const start = args.dateFrom ? parseDate(args.dateFrom) : end - days * 86400000;
    if (start >= end) throw new Error("dateFrom must precede dateTo");
    const offset = args.offset === undefined ? 0 : Number(args.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
    const ids = await Zotero.Items.getAll(feedID, true, false, true);
    const matches: Array<{ ref: ZoteroObjectRef; date: number }> = [];
    let unknownDates = 0;
    let dateReadErrors = 0;
    // Read only feed metadata through the host API, never the semantic/SQLite index.
    for (let i = 0; i < Math.min(ids.length, 5000); i += 100) {
      const items = await Zotero.Items.getAsync(ids.slice(i, Math.min(i + 100, 5000)));
      for (const item of items) {
        if (dateBasis === "published") {
          try {
            await Zotero.Items.loadDataTypes([item], ["itemData"]);
          } catch {
            dateReadErrors++;
            continue;
          }
        }
        const value =
          dateBasis === "added" ? item.dateAdded : String(item.getField("date") || "");
        const date = Date.parse(value);
        if (!Number.isFinite(date)) {
          unknownDates++;
          continue;
        }
        if (date >= start && date < end)
          matches.push({ ref: { libraryID: feedID, itemKey: item.key }, date });
      }
    }
    matches.sort(
      (a, b) => b.date - a.date || a.ref.itemKey.localeCompare(b.ref.itemKey),
    );
    return {
      records: await this.records(
        matches.slice(offset, offset + 10).map((entry) => entry.ref),
      ),
      totalAvailable: matches.length,
      offset,
      unknownDates,
      dateReadErrors,
      scanTruncated: ids.length > 5000,
      dateBasis,
      dateFrom: new Date(start).toISOString(),
      dateToExclusive: new Date(end).toISOString(),
    };
  }
}
