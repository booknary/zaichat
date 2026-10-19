import { ZoteroObjectRef } from "../core/types";
import { feedText } from "./feedReader";
import { isRegularItem } from "./itemTypes";
import { authorEvidence } from "../agent/authorEvidence";

/** Direct metadata reads, including creator-field lookup; no vectors, network or PDFs. */
export class DirectReader {
  async authors(names: string[], match: "any" | "all", offset: number) {
    if (
      !names.length ||
      names.length > 4 ||
      names.some(
        (name) =>
          typeof name !== "string" || name.trim().length < 2 || name.length > 100,
      ) ||
      !["any", "all"].includes(match) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error(
        "Supply 1–4 author names, any/all matching and a nonnegative offset",
      );
    const libraryID = Zotero.Libraries.userLibraryID;
    const ids = new Set<number>();
    let scanTruncated = false;
    const searched = new Set<string>();
    for (const name of names) {
      const surname = name.includes(",")
        ? name.split(",")[0].trim()
        : name.trim().split(/\s+/).at(-1)!;
      if (searched.has(surname.toLowerCase())) continue;
      searched.add(surname.toLowerCase());
      const search = new Zotero.Search();
      (search as any).libraryID = libraryID;
      search.addCondition("creator", "contains", surname);
      for (const id of await search.search()) {
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        if (ids.size >= 5000) {
          scanTruncated = true;
          break;
        }
        ids.add(id);
      }
    }
    const records = [];
    for (const id of [...ids].sort((a, b) => a - b)) {
      const item = await Zotero.Items.getAsync(id);
      if (!item || item.libraryID !== libraryID || item.deleted || !isRegularItem(item))
        continue;
      await Zotero.Items.loadDataTypes([item], ["itemData", "creators"]);
      const authors = item
        .getCreators()
        .filter((c) => c.creatorTypeID === Zotero.CreatorTypes.getID("author"))
        .map((c) => `${c.firstName || ""} ${c.lastName || ""}`.trim());
      const matches = names.map((name) => authorEvidence(authors, name));
      if (
        !(match === "all"
          ? matches.every((m) => m.authorMatches.length)
          : matches.some((m) => m.authorMatches.length))
      )
        continue;
      records.push({
        item: { libraryID, itemKey: item.key },
        title: feedText(item.getField("title")),
        date: String(item.getField("date") || ""),
        publicationTitle: String(item.getField("publicationTitle") || ""),
        doi: String(item.getField("DOI") || ""),
        authorCount: authors.length,
        matches,
        fullAuthorFieldChecked: true,
        abstract: undefined,
        abstractMissing: undefined,
        abstractTruncated: undefined,
        readError: undefined,
      });
    }
    return {
      records: records.slice(offset, offset + 20),
      total: records.length,
      scanTruncated,
    };
  }
  private snapshots = new Map<
    string,
    { refs: ZoteroObjectRef[]; truncated: boolean }
  >();
  clear() {
    this.snapshots.clear();
  }

  async records(refs: ZoteroObjectRef[], abstracts: boolean) {
    return Promise.all(
      refs.map(async (ref) => {
        try {
          const item = await Zotero.Items.getByLibraryAndKeyAsync(
            ref.libraryID,
            ref.itemKey,
          );
          if (!item || item.deleted || !isRegularItem(item))
            throw new Error("UnavailableItem");
          await Zotero.Items.loadDataTypes([item], ["itemData"]);
          const raw = abstracts ? feedText(item.getField("abstractNote")) : undefined;
          return {
            item: ref,
            title: feedText(item.getField("title")),
            date: String(item.getField("date") || ""),
            publicationTitle: String(item.getField("publicationTitle") || ""),
            doi: String(item.getField("DOI") || ""),
            abstract: raw?.slice(0, 16000),
            abstractMissing: abstracts ? !raw : undefined,
            abstractTruncated: raw ? raw.length > 16000 : undefined,
            readError: undefined as string | undefined,
          };
        } catch (error) {
          return {
            item: ref,
            title: "",
            readError: error instanceof Error ? error.name : "ReadError",
          };
        }
      }),
    );
  }

  async collection(key: string, recursive: boolean, offset: number) {
    if (!key || !Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid collection key or offset");
    const libraryID = Zotero.Libraries.userLibraryID;
    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, key);
    if (!collection || collection.deleted)
      throw new Error("Collection unavailable in My Library");
    const cacheKey = `${libraryID}:${key}:${recursive}`;
    if (!this.snapshots.has(cacheKey)) {
      const queue = [collection],
        seen = new Set<number>(),
        refs = new Map<string, ZoteroObjectRef>();
      let truncated = false;
      while (queue.length) {
        if (seen.size >= 200 || refs.size >= 5000) {
          truncated = true;
          break;
        }
        const current = queue.shift()!;
        if (seen.has(current.id)) continue;
        seen.add(current.id);
        await current.loadDataType("childItems");
        let children = current.getChildItems(false, false) as any[];
        if (children.some((item) => !item)) {
          // Zotero's collection cache may return false for unloaded items.
          // Query exact membership via the host API, never text/vector search.
          const membership = new Zotero.Search();
          (membership as any).libraryID = libraryID;
          membership.addCondition("collection", "is", current.key);
          children = await membership.search();
        }
        for (const raw of children) {
          const item = typeof raw === "number" ? await Zotero.Items.getAsync(raw) : raw;
          if (!item) continue;
          if (item.libraryID !== libraryID || item.deleted || !isRegularItem(item))
            continue;
          if (refs.size >= 5000) {
            truncated = true;
            break;
          }
          refs.set(item.key, { libraryID, itemKey: item.key });
        }
        if (recursive) {
          await current.loadDataType("childCollections");
          for (const raw of current.getChildCollections(false, false) as any[]) {
            const child =
              typeof raw === "number" ? await Zotero.Collections.getAsync(raw) : raw;
            if (child && !child.deleted) queue.push(child);
          }
        }
      }
      this.snapshots.set(cacheKey, {
        refs: [...refs.values()].sort((a, b) => a.itemKey.localeCompare(b.itemKey)),
        truncated,
      });
    }
    const snapshot = this.snapshots.get(cacheKey)!;
    return {
      name: collection.name,
      total: snapshot.refs.length,
      scanTruncated: snapshot.truncated,
      records: await this.records(snapshot.refs.slice(offset, offset + 20), false),
    };
  }
}
