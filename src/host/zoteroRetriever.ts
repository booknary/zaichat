import {
  EvidenceSnippet,
  RetrievalQuery,
  RetrievedItem,
  RetrievalCandidate,
  RetrievalProvenance,
  SourceReference,
  ZoteroObjectRef,
  ToolResult,
} from "../core/types";
import {
  normalizeText,
  passesHardFilters,
  rankDocuments,
  recallTerms,
  scoreDocument,
  SearchDocument,
} from "../retrieval/ranking";
import { PaperSemanticSearchResult } from "../semantic/types";
import { createID } from "../utils/ids";
import { candidateExcerpt } from "../utils/candidatePreview";
import { isAttachmentItem, isRegularItem } from "./itemTypes";
import {
  adjacentPassage,
  rankPassages,
  scanTermHits,
} from "../retrieval/passageReader";
import { classifyPassage, indexCompleteness } from "../retrieval/evidenceProvenance";
import { suppliedExactTitles } from "../retrieval/exactTitleResolution";

const MAX_ATTACHMENT_TEXT_CHARS = 200_000;
const MAX_ABSTRACT_EXCERPT_CHARS = 360;
export const MAX_FULLTEXT_DISCOVERY_CANDIDATES = 30;
export const MAX_FULLTEXT_DISCOVERY_ROUTES = 24;
export const MAX_FULLTEXT_HITS_PER_ROUTE = 200;
const MAX_METADATA_DISCOVERY_CANDIDATES = 220;
const MAX_LOCAL_DOCUMENTS = 320;

interface MetadataRecallResult {
  ids: number[];
  provenanceByID: Map<number, Set<RetrievalProvenance>>;
}

interface FulltextDiscoveryHit {
  terms: Set<string>;
  attachments: Map<string, ZoteroObjectRef>;
}

interface FulltextRecallResult {
  ids: number[];
  hitsByParentID: Map<number, FulltextDiscoveryHit>;
}

export interface RetrievalDiscoveryStats {
  exactTitleResolved?: boolean;
  scope?: "supplied-exact-titles";
  fulltextDeferred?: boolean;
  timingsMs?: Record<string, number>;
  exactTitleCandidates: number;
  metadataCandidates: number;
  fulltextCandidates: number;
  fulltextRoutes: number;
  semanticCandidates: number;
  unreadableItems?: number;
  semanticFailedRoutes?: number;
  degradedFields?: Record<string, number>;
  documentsLoaded?: number;
  documentsCapped?: number;
  hardFiltered?: number;
  semanticRoutes?: string[];
}

export interface PaperSemanticSearchProvider {
  searchPapers(query: string, limit?: number): Promise<PaperSemanticSearchResult[]>;
}

export class ZoteroRetriever {
  private evidenceCaches = new Map<string, { text: string; cacheChars: number }>();
  private snippetCoverage: Array<Record<string, unknown>> = [];
  private recallCache = new Map<string, Promise<any>>();
  resetEvidenceSession(): void {
    this.evidenceCaches.clear();
    this.snippetCoverage = [];
    this.recallCache.clear();
  }
  getSnippetCoverage() {
    return this.snippetCoverage;
  }
  constructor(private readonly semantic?: PaperSemanticSearchProvider) {}

  async searchLibrary(
    query: RetrievalQuery,
    userQuery = "",
    options: { deferFulltext?: boolean; preferExactTitles?: boolean } = {},
  ): Promise<{
    items: RetrievalCandidate[];
    sources: SourceReference[];
    discovery: RetrievalDiscoveryStats;
    trace?: ToolResult["retrievalTrace"];
    routeTrace?: ToolResult["retrievalRouteTrace"];
  }> {
    const started = Date.now();
    let checkpoint = started;
    const timingsMs: Record<string, number> = {};
    const mark = (phase: string) => {
      const now = Date.now();
      timingsMs[phase] = now - checkpoint;
      checkpoint = now;
    };
    const userLibraryID = Zotero.Libraries.userLibraryID;
    if (options.preferExactTitles) {
      const direct = await this.resolveSuppliedTitles(query, userQuery, userLibraryID);
      if (direct) {
        timingsMs.exactTitleRecall = Date.now() - started;
        timingsMs.total = Date.now() - started;
        direct.discovery.timingsMs = timingsMs;
        return direct;
      }
    }
    const directTitleIDs = await this.recallExactTitles(
      userLibraryID,
      query.exactTitles || [],
    );
    mark("exactTitleRecall");
    const cacheKey = JSON.stringify([
      userLibraryID,
      { ...query, limit: 50 },
      userQuery,
    ]);
    const semanticRouteResults: PaperSemanticSearchResult[][] = [];
    let semanticFailedRoutes = 0;
    const semanticRoutes = semanticQueryTexts(query, userQuery);
    // Independent worker recall can overlap Zotero search. Host DB searches and
    // semantic routes remain individually sequential, with identical route order.
    const [{ metadataRecall, fulltextRecall }] = await Promise.all([
      (async () => {
        const metadataStart = Date.now();
        const metadataRecall: MetadataRecallResult = await this.cachedRecall(
          `metadata:${cacheKey}`,
          () => this.recallRegularItems(userLibraryID, query, userQuery),
        );
        timingsMs.metadataRecall = Date.now() - metadataStart;
        const fulltextStart = Date.now();
        const fulltextRecall: FulltextRecallResult = options.deferFulltext
          ? { ids: [], hitsByParentID: new Map() }
          : await this.cachedRecall(`fulltext:${cacheKey}`, () =>
              this.recallFulltextItems(userLibraryID, query, userQuery),
            );
        timingsMs.fulltextRecall = Date.now() - fulltextStart;
        return { metadataRecall, fulltextRecall };
      })(),
      (async () => {
        const semanticStart = Date.now();
        if (this.semantic)
          for (const route of semanticRoutes) {
            try {
              semanticRouteResults.push(
                await this.cachedRecall(`semantic:${route}`, () =>
                  this.semantic!.searchPapers(route, 30),
                ),
              );
            } catch (error) {
              semanticFailedRoutes++;
              semanticRouteResults.push([]);
              Zotero.logError(
                new Error(`ZaiChat semantic recall failed: ${safeError(error)}`),
              );
            }
          }
        timingsMs.semanticRecall = Date.now() - semanticStart;
      })(),
    ]);
    checkpoint = Date.now();
    const semanticHits = fuseSemanticRouteResults(semanticRouteResults, 60);
    const semanticByKey = new Map(
      semanticHits
        .filter((hit) => hit.libraryID === userLibraryID)
        .map((hit) => [hit.itemKey, hit] as const),
    );
    const semanticIDs = semanticHits
      .filter((hit) => hit.libraryID === userLibraryID)
      .map((hit) => {
        const item = Zotero.Items.getByLibraryAndKey(hit.libraryID, hit.itemKey);
        return item ? item.id : undefined;
      })
      .filter((id): id is number => Number.isInteger(id) && Number(id) > 0);
    const itemIDs = [
      ...new Set([
        ...directTitleIDs,
        ...semanticIDs,
        ...fulltextRecall.ids,
        ...metadataRecall.ids,
      ]),
    ];
    const directTitleSet = new Set(directTitleIDs);
    const documents: SearchDocument[] = [];
    let unreadableItems = 0;
    for (const itemID of itemIDs.slice(0, MAX_LOCAL_DOCUMENTS)) {
      try {
        const item = await Zotero.Items.getAsync(itemID);
        if (
          !item ||
          item.deleted ||
          item.libraryID !== userLibraryID ||
          !isRegularItem(item)
        )
          continue;
        const document = await this.toDocument(item);
        const provenance = new Set<RetrievalProvenance>(
          metadataRecall.provenanceByID.get(itemID) || [],
        );
        if (directTitleSet.has(itemID)) provenance.add("exact-title");
        const semanticHit = semanticByKey.get(item.key);
        if (semanticHit) provenance.add("semantic");
        const fulltextHit = fulltextRecall.hitsByParentID.get(itemID);
        if (fulltextHit) {
          provenance.add("fulltext");
          document.fulltextMatchTerms = [...fulltextHit.terms].slice(0, 12);
          // Matched index terms are sufficient for deterministic ranking. The
          // attachment cache itself is read only by the bounded verification tools.
          document.fulltext = document.fulltextMatchTerms;
          document.attachmentRefs = dedupeObjectRefs([
            ...fulltextHit.attachments.values(),
            ...(document.attachmentRefs || []),
          ]);
        }
        document.provenance = [...provenance];
        documents.push(document);
      } catch (error) {
        unreadableItems++;
        Zotero.logError(
          new Error(
            `ZaiChat skipped unreadable library item ${itemID}: ${safeError(error)}`,
          ),
        );
      }
    }
    mark("documentLoading");
    const lexical = rankDocuments(documents, { ...query, limit: 50 });
    const scoredByKey = new Map(lexical.map((item) => [item.item.itemKey, item]));
    const documentByKey = new Map(
      documents.map((document) => [document.item.itemKey, document] as const),
    );
    const semanticRanked: RetrievedItem[] = [];
    for (const hit of semanticHits) {
      if (hit.libraryID !== userLibraryID) continue;
      const document = documentByKey.get(hit.itemKey);
      if (!document || !passesHardFilters(document, query)) continue;
      const scored = scoredByKey.get(hit.itemKey) || scoreDocument(document, query);
      semanticRanked.push({
        ...scored,
        provenance: [...new Set([...(scored.provenance || []), "semantic" as const])],
        matchedFields: [
          ...new Set([
            ...scored.matchedFields,
            ...hit.sourceFields.map(semanticFieldToEvidenceField),
          ]),
        ],
        score: hit.score,
      });
    }
    const ranked = fuseHybridResults(
      lexical,
      semanticRanked,
      query.limit,
      query.intent === "remembered_item" ? 0.8 : 0.55,
      query.exactTitles,
    );
    mark("ranking");
    timingsMs.total = Date.now() - started;
    const sources = ranked.map((item) => this.toSource(item));
    const rankOf = (items: Array<{ item: ZoteroObjectRef }>, key: string) => {
      const index = items.findIndex((item) => item.item.itemKey === key);
      return index < 0 ? undefined : index + 1;
    };
    const traceRefs = new Map(
      documents.map((document) => [document.item.itemKey, document.item]),
    );
    for (const hit of semanticHits)
      if (hit.libraryID === userLibraryID && !traceRefs.has(hit.itemKey))
        traceRefs.set(hit.itemKey, { libraryID: hit.libraryID, itemKey: hit.itemKey });
    return {
      routeTrace: semanticRouteResults.map((hits, routeIndex) => ({
        routeIndex,
        hits: hits
          .map((hit, index) => ({
            libraryID: hit.libraryID,
            itemKey: hit.itemKey,
            rank: index + 1,
            score: hit.score,
          }))
          .filter((hit) => hit.libraryID === userLibraryID),
      })),
      trace: [...traceRefs.values()].slice(0, MAX_LOCAL_DOCUMENTS + 60).map((ref) => {
        const doc = documentByKey.get(ref.itemKey);
        const semanticIndex = semanticHits.findIndex(
          (hit) => hit.libraryID === ref.libraryID && hit.itemKey === ref.itemKey,
        );
        const fusedRank = rankOf(ranked, ref.itemKey);
        return {
          libraryID: ref.libraryID,
          itemKey: ref.itemKey,
          semanticRank: semanticIndex < 0 ? undefined : semanticIndex + 1,
          lexicalRank: rankOf(lexical, ref.itemKey),
          fusedRank,
          readWarnings: doc?.readWarnings,
          stage: !doc
            ? "not-loaded"
            : !passesHardFilters(doc, query)
              ? "hard-filtered"
              : fusedRank
                ? "selected"
                : "rank-cutoff",
        };
      }),
      items: ranked.map((item, index) =>
        this.toCandidate(item, undefined, sources[index].sourceID, recallTerms(query)),
      ),
      sources,
      discovery: {
        fulltextDeferred: Boolean(options.deferFulltext),
        timingsMs,
        exactTitleCandidates: directTitleIDs.length,
        metadataCandidates: metadataRecall.ids.length,
        fulltextCandidates: fulltextRecall.ids.length,
        fulltextRoutes: options.deferFulltext
          ? 0
          : fulltextDiscoveryTerms(query, MAX_FULLTEXT_DISCOVERY_ROUTES, userQuery)
              .length,
        semanticCandidates: semanticHits.length,
        unreadableItems,
        semanticFailedRoutes,
        semanticRoutes: this.semantic ? semanticRoutes : [],
        documentsLoaded: documents.length,
        documentsCapped: Math.max(0, itemIDs.length - MAX_LOCAL_DOCUMENTS),
        hardFiltered: documents.filter(
          (document) => !passesHardFilters(document, query),
        ).length,
        degradedFields: documents
          .flatMap((document) => document.readWarnings || [])
          .reduce<Record<string, number>>((counts, field) => {
            counts[field] = (counts[field] || 0) + 1;
            return counts;
          }, {}),
      },
    };
  }

  private cachedRecall<T>(key: string, read: () => Promise<T>): Promise<T> {
    let pending = this.recallCache.get(key);
    if (!pending) {
      pending = read().catch((error) => {
        this.recallCache.delete(key);
        throw error;
      });
      this.recallCache.set(key, pending);
    }
    return pending;
  }

  private async resolveSuppliedTitles(
    query: RetrievalQuery,
    userQuery: string,
    libraryID: number,
  ): Promise<Awaited<ReturnType<ZoteroRetriever["searchLibrary"]>> | undefined> {
    const titles = suppliedExactTitles(query, userQuery);
    if (!titles.length) return undefined;
    const documents = new Map<number, SearchDocument>();
    for (const title of titles) {
      const search = new Zotero.Search();
      (search as any).libraryID = libraryID;
      search.addCondition("title", "is", title);
      search.addCondition("noChildren", "true");
      try {
        const ids = validItemIDs(await search.search());
        if (!ids.length || ids.length > 50) return undefined;
        let resolved = false;
        for (const id of ids) {
          const item = await Zotero.Items.getAsync(id);
          if (
            !item ||
            item.deleted ||
            item.libraryID !== libraryID ||
            !isRegularItem(item)
          )
            continue;
          const document = documents.get(id) || (await this.toDocument(item));
          if (document.readWarnings?.length) return undefined;
          if (
            normalizeText(document.title) !== normalizeText(title) ||
            !passesHardFilters(document, query)
          )
            continue;
          document.provenance = ["exact-title", "metadata"];
          documents.set(id, document);
          resolved = true;
        }
        if (!resolved) return undefined;
      } catch (error) {
        Zotero.logError(
          new Error(`ZaiChat direct title resolution fell back: ${safeError(error)}`),
        );
        return undefined;
      }
    }
    const ranked = rankDocuments([...documents.values()], { ...query, limit: 50 });
    if (ranked.length !== documents.size) return undefined;
    const sources = ranked.map((item) => this.toSource(item));
    return {
      items: ranked.map((item, index) =>
        this.toCandidate(item, undefined, sources[index].sourceID, recallTerms(query)),
      ),
      sources,
      trace: ranked.map((item, index) => ({
        libraryID,
        itemKey: item.item.itemKey,
        lexicalRank: index + 1,
        fusedRank: index + 1,
        stage: "selected",
      })),
      routeTrace: [],
      discovery: {
        exactTitleResolved: true,
        scope: "supplied-exact-titles",
        fulltextDeferred: true,
        exactTitleCandidates: ranked.length,
        metadataCandidates: ranked.length,
        fulltextCandidates: 0,
        fulltextRoutes: 0,
        semanticCandidates: 0,
        documentsLoaded: documents.size,
      },
    };
  }

  async searchFulltext(
    query: RetrievalQuery,
    maxAttachments = 20,
    candidateRefs: ZoteroObjectRef[] = [],
  ): Promise<{ items: RetrievalCandidate[]; sources: SourceReference[] }> {
    const documents: SearchDocument[] = [];
    let attachmentCount = 0;
    for (const ref of dedupeObjectRefs(candidateRefs).slice(0, 12)) {
      if (attachmentCount >= maxAttachments) break;
      const parent = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.itemKey);
      if (
        !parent ||
        parent.libraryID !== Zotero.Libraries.userLibraryID ||
        !isRegularItem(parent)
      )
        continue;
      const entries: Array<{ attachment: Zotero.Item; text: string }> = [];
      const attachmentIDs = validItemIDs((parent as any).getAttachments?.() || []);
      for (const id of attachmentIDs) {
        if (attachmentCount >= maxAttachments) break;
        const attachment = await Zotero.Items.getAsync(id);
        if (!attachment || !isAttachmentItem(attachment)) continue;
        attachmentCount++;
        const text = await this.readIndexedText(attachment);
        if (text) entries.push({ attachment, text });
      }
      if (!entries.length) continue;
      const document = await this.toDocument(parent);
      document.fulltext = entries.map((entry) => entry.text);
      document.provenance = [
        ...new Set([...(document.provenance || []), "fulltext" as const]),
      ];
      document.attachmentRefs = entries.map((entry) => this.ref(entry.attachment));
      documents.push(document);
    }
    const ranked = rankDocuments(documents, query).filter((item) =>
      item.matchedFields.includes("fulltext"),
    );
    const sources = ranked.map((item) => this.toSource(item, "fulltext"));
    return {
      items: ranked.map((item, index) =>
        this.toCandidate(item, "indexed", sources[index].sourceID, recallTerms(query)),
      ),
      sources,
    };
  }

  async readSnippets(
    attachmentRefs: ZoteroObjectRef[],
    terms: string[],
    maxAttachments: number,
    maxPerAttachment: number,
    maxChars: number,
    options?: {
      exclude?: Array<{ attachment: ZoteroObjectRef; start: number; end: number }>;
      adjacent?: { start: number; end: number; direction: "before" | "after" };
    },
  ): Promise<EvidenceSnippet[]> {
    const snippets: EvidenceSnippet[] = [];
    this.snippetCoverage = [];
    for (const ref of attachmentRefs.slice(0, maxAttachments)) {
      const attachment = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.itemKey);
      if (!attachment || !isAttachmentItem(attachment)) {
        this.snippetCoverage.push({
          attachment: ref,
          state: "attachment-unavailable",
          returned: 0,
        });
        continue;
      }
      const parentResult = Number((attachment as any).parentItemID || 0)
        ? await Zotero.Items.getAsync((attachment as any).parentItemID)
        : undefined;
      const parent = parentResult || undefined;
      const cacheKey = `${ref.libraryID}:${ref.itemKey}`;
      let cached = this.evidenceCaches.get(cacheKey);
      if (!cached) {
        const file = (Zotero.Fulltext as any).getItemCacheFile?.(attachment);
        const path = file?.path || file;
        if (!path || !(await IOUtils.exists(path))) {
          this.snippetCoverage.push({ attachment: ref, state: "cache-missing" });
          continue;
        }
        const full = String(await Zotero.File.getContentsAsync(path));
        cached = { text: full.slice(0, 2_000_000), cacheChars: full.length };
        if (this.evidenceCaches.size >= 20)
          this.evidenceCaches.delete(this.evidenceCaches.keys().next().value!);
        this.evidenceCaches.set(cacheKey, cached);
      }
      const { text, cacheChars } = cached;
      const excluded = (options?.exclude || []).filter(
        (span) =>
          span.attachment.libraryID === ref.libraryID &&
          span.attachment.itemKey === ref.itemKey,
      );
      const hits = options?.adjacent ? [] : scanTermHits(text, terms);
      const extracted = options?.adjacent
        ? adjacentPassage(
            text,
            options.adjacent,
            options.adjacent.direction,
            maxChars,
            excluded,
          )
        : rankPassages(text, terms, maxPerAttachment, maxChars, excluded, hits);
      // Zotero 9's API accepts the attachment item itself. Passing its
      // numeric ID makes Zotero call item.isAttachment() on a number.
      const indexState = String(
        (await (Zotero.Fulltext as any).getIndexedState?.(attachment)) ?? "unknown",
      );
      const coverage = {
        cacheChars,
        scannedChars: text.length,
        truncated: cacheChars > text.length,
      };
      this.snippetCoverage.push({
        attachment: ref,
        indexState,
        indexCompleteness: indexCompleteness(indexState),
        ...coverage,
        termHits: hits.map(({ term, positions, countCapped }) => ({
          term,
          count: positions.length,
          countCapped,
          returnedInPassages: extracted.some((passage) =>
            passage.matchedTerms.includes(term),
          ),
        })),
        returned: extracted.length,
        outcome: extracted.length
          ? "passages-returned"
          : options?.adjacent
            ? "no-new-adjacent-passage"
            : !hits.some((hit) => hit.positions.length)
              ? "no-term-match-in-scanned-cache"
              : excluded.length &&
                  rankPassages(text, terms, 1, maxChars, [], hits).length
                ? "already-delivered"
                : "matches-not-selected",
        limitation:
          "Local cache only; empty or previously seen passages do not establish whole-document absence. Offsets are cache characters, not PDF pages.",
      });
      for (const snippet of extracted) {
        snippets.push({
          sourceID: createID("src"),
          item: parent ? this.ref(parent) : ref,
          attachment: this.ref(attachment),
          text: snippet.text,
          field: "fulltext",
          score: snippet.score,
          indexState,
          position: { start: snippet.start, end: snippet.end },
          matchedTerms: snippet.matchedTerms,
          provenance: classifyPassage(text, snippet.start, snippet.end),
          coverage,
        });
      }
    }
    return snippets;
  }

  async listAttachments(ref: ZoteroObjectRef, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid attachment offset");
    const parent = await Zotero.Items.getByLibraryAndKeyAsync(
      ref.libraryID,
      ref.itemKey,
    );
    if (!parent || parent.deleted || !isRegularItem(parent))
      throw new Error("Parent paper unavailable");
    await Zotero.Items.loadDataTypes([parent], ["childItems"]);
    const ids = validItemIDs(parent.getAttachments());
    const items = [];
    for (const id of ids.slice(offset, offset + 20)) {
      const attachment = await Zotero.Items.getAsync(id);
      if (!attachment || attachment.deleted) continue;
      const attachmentRef = this.ref(attachment);
      const contentType = String(attachment.attachmentContentType || "unknown");
      const supplementary =
        /supplement|supporting|additional|appendix|补充|附录/iu.test(
          attachmentRef.title || "",
        );
      const supported = /^(?:application\/pdf|text\/)/i.test(contentType);
      const file = supported
        ? (Zotero.Fulltext as any).getItemCacheFile?.(attachment)
        : undefined;
      const path = file?.path || file;
      const cached = Boolean(path && (await IOUtils.exists(path)));
      items.push({
        attachment: attachmentRef,
        contentType,
        roleHint: supplementary ? "possible-supplement" : "unclassified",
        state: !supported
          ? "unsupported-format"
          : cached
            ? "cache-available-not-read"
            : "cache-missing",
        roleIsHeuristic: true,
      });
    }
    return {
      items,
      totalAvailable: ids.length,
      offset,
      nextOffset: offset + 20 < ids.length ? offset + 20 : null,
    };
  }

  async getItems(
    refs: ZoteroObjectRef[],
    fullAuthors = false,
  ): Promise<{ items: RetrievalCandidate[]; sources: SourceReference[] }> {
    const items: RetrievalCandidate[] = [];
    const sources: SourceReference[] = [];
    for (const ref of refs.slice(0, 8)) {
      const resolved = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.itemKey);
      const item =
        resolved && isAttachmentItem(resolved) && resolved.parentItemID
          ? await Zotero.Items.getAsync(resolved.parentItemID)
          : resolved;
      if (item && !item.deleted && isRegularItem(item)) {
        const retrieved = {
          ...(await this.toDocument(item)),
          provenance: ["metadata", "abstract"] as RetrievalProvenance[],
          score: 1,
          matchedFields: [] as EvidenceSnippet["field"][],
        };
        const source = this.toSource(retrieved, "abstract");
        if (
          items.some(
            (entry) =>
              entry.item.libraryID === item.libraryID &&
              entry.item.itemKey === item.key,
          )
        )
          continue;
        const candidate = this.toCandidate(retrieved, undefined, source.sourceID);
        if (fullAuthors) {
          candidate.authors = retrieved.authors;
          candidate.authorsTruncated =
            retrieved.readWarnings?.includes("authors") || false;
        }
        items.push(candidate);
        sources.push(source);
      }
    }
    return { items, sources };
  }

  async listCollections(): Promise<
    Array<{ libraryID: number; key: string; name: string }>
  > {
    return Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, true).map(
      (collection: Zotero.Collection) => ({
        libraryID: collection.libraryID,
        key: collection.key,
        name: collection.name,
      }),
    );
  }

  async listNotes(
    ref: ZoteroObjectRef,
  ): Promise<Array<{ ref: ZoteroObjectRef; text: string }>> {
    const item = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.itemKey);
    if (!item) return [];
    const childIDs = (item as any).getNotes?.() || [];
    const notes = childIDs.length ? await Zotero.Items.getAsync(childIDs) : [];
    const noteList = Array.isArray(notes) ? notes : [notes];
    return noteList
      .filter((note): note is Zotero.Item => Boolean(note))
      .map((note) => ({
        ref: this.ref(note),
        text: clip(stripHTML(String((note as any).getNote?.() || "")), 4000),
      }));
  }

  async listAnnotations(
    ref: ZoteroObjectRef,
  ): Promise<Array<{ ref: ZoteroObjectRef; text: string }>> {
    const item = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.itemKey);
    if (!item) return [];
    const attachmentIDs = isAttachmentItem(item)
      ? [item.id]
      : (item as any).getAttachments?.() || [];
    const result: Array<{ ref: ZoteroObjectRef; text: string }> = [];
    for (const attachmentID of attachmentIDs) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      // Zotero returns annotation Item objects, unlike getNotes/getAttachments IDs.
      // Feeding these objects to getAsync coerces them to NaN and breaks the parent paper.
      const annotations = (attachment as any)?.getAnnotations?.() || [];
      const annotationList = Array.isArray(annotations) ? annotations : [annotations];
      for (const annotation of annotationList.filter((entry): entry is Zotero.Item =>
        Boolean(entry),
      )) {
        const text = [
          String((annotation as any).annotationText || ""),
          String((annotation as any).annotationComment || ""),
        ]
          .filter(Boolean)
          .join(" — ");
        if (text) result.push({ ref: this.ref(annotation), text: clip(text, 4000) });
      }
    }
    return result;
  }

  private async recallRegularItems(
    libraryID: number,
    query: RetrievalQuery,
    userQuery = "",
  ): Promise<MetadataRecallResult> {
    const terms = [
      ...new Set([...literalUserTerms(userQuery), ...recallTerms(query)]),
    ].slice(0, 36);
    const provenanceByID = new Map<number, Set<RetrievalProvenance>>();
    if (!terms.length) {
      const search = new Zotero.Search();
      (search as any).libraryID = libraryID;
      search.addCondition("noChildren", "true");
      const ids = validItemIDs(await search.search()).slice(
        0,
        MAX_METADATA_DISCOVERY_CANDIDATES,
      );
      for (const id of ids) markProvenance(provenanceByID, id, "metadata");
      return { ids, provenanceByID };
    }
    const buckets: RecallBucket[] = [];
    for (const term of terms) {
      const metadataIDs: number[] = [];
      const search = new Zotero.Search();
      (search as any).libraryID = libraryID;
      search.addCondition("quicksearch-titleCreatorYear", "contains", term);
      search.addCondition("noChildren", "true");
      try {
        for (const id of validItemIDs(
          await this.cachedRecall(
            `metadata-field:${JSON.stringify([libraryID, "titleCreatorYear", term])}`,
            () => search.search(),
          ),
        )) {
          metadataIDs.push(id);
          markProvenance(provenanceByID, id, "metadata");
        }
      } catch (error) {
        Zotero.logError(
          new Error(`ZaiChat title search failed for one term: ${safeError(error)}`),
        );
      }
      if (metadataIDs.length) buckets.push({ term, ids: metadataIDs });
      const abstractIDs: number[] = [];
      const abstractSearch = new Zotero.Search();
      (abstractSearch as any).libraryID = libraryID;
      abstractSearch.addCondition("abstractNote", "contains", term);
      abstractSearch.addCondition("noChildren", "true");
      try {
        for (const id of validItemIDs(
          await this.cachedRecall(
            `metadata-field:${JSON.stringify([libraryID, "abstractNote", term])}`,
            () => abstractSearch.search(),
          ),
        )) {
          abstractIDs.push(id);
          markProvenance(provenanceByID, id, "abstract");
        }
      } catch (error) {
        Zotero.logError(
          new Error(`ZaiChat abstract search failed for one term: ${safeError(error)}`),
        );
      }
      if (abstractIDs.length) buckets.push({ term, ids: abstractIDs });
      const tagIDs: number[] = [];
      const tagSearch = new Zotero.Search();
      (tagSearch as any).libraryID = libraryID;
      tagSearch.addCondition("tag", "contains", term);
      tagSearch.addCondition("noChildren", "true");
      try {
        for (const id of validItemIDs(
          await this.cachedRecall(
            `metadata-field:${JSON.stringify([libraryID, "tag", term])}`,
            () => tagSearch.search(),
          ),
        )) {
          tagIDs.push(id);
          markProvenance(provenanceByID, id, "tag");
        }
      } catch (error) {
        Zotero.logError(
          new Error(`ZaiChat tag search failed for one term: ${safeError(error)}`),
        );
      }
      if (tagIDs.length) buckets.push({ term, ids: tagIDs });
    }
    return {
      ids: fuseRecallBuckets(buckets, MAX_METADATA_DISCOVERY_CANDIDATES),
      provenanceByID,
    };
  }

  private async recallFulltextItems(
    libraryID: number,
    query: RetrievalQuery,
    userQuery = "",
  ): Promise<FulltextRecallResult> {
    const terms = fulltextDiscoveryTerms(
      query,
      MAX_FULLTEXT_DISCOVERY_ROUTES,
      userQuery,
    );
    const hitsByParentID = new Map<number, FulltextDiscoveryHit>();
    const buckets: RecallBucket[] = [];
    const attachmentCache = new Map<number, Zotero.Item | undefined>();
    const parentCache = new Map<number, Zotero.Item | undefined>();
    for (const term of terms) {
      const search = new Zotero.Search();
      (search as any).libraryID = libraryID;
      search.addCondition("fulltextContent", "contains", term);
      let attachmentIDs: number[] = [];
      try {
        attachmentIDs = validItemIDs(await search.search()).slice(
          0,
          MAX_FULLTEXT_HITS_PER_ROUTE,
        );
      } catch (error) {
        Zotero.logError(
          new Error(
            `ZaiChat indexed-fulltext discovery failed for one term: ${safeError(error)}`,
          ),
        );
      }
      const parentIDs = new Set<number>();
      for (const attachmentID of attachmentIDs) {
        let attachment = attachmentCache.get(attachmentID);
        if (!attachmentCache.has(attachmentID)) {
          attachment = (await Zotero.Items.getAsync(attachmentID)) || undefined;
          attachmentCache.set(attachmentID, attachment);
        }
        if (
          !attachment ||
          attachment.libraryID !== libraryID ||
          !isAttachmentItem(attachment)
        )
          continue;
        const parentID = Number((attachment as any).parentItemID || 0);
        if (!Number.isInteger(parentID) || parentID <= 0) continue;
        let parent = parentCache.get(parentID);
        if (!parentCache.has(parentID)) {
          parent = (await Zotero.Items.getAsync(parentID)) || undefined;
          parentCache.set(parentID, parent);
        }
        if (!parent || parent.libraryID !== libraryID || !isRegularItem(parent))
          continue;
        parentIDs.add(parentID);
        const hit = hitsByParentID.get(parentID) || {
          terms: new Set<string>(),
          attachments: new Map<string, ZoteroObjectRef>(),
        };
        hit.terms.add(term);
        const ref = this.ref(attachment);
        hit.attachments.set(`${ref.libraryID}:${ref.itemKey}`, ref);
        hitsByParentID.set(parentID, hit);
      }
      if (parentIDs.size) buckets.push({ term, ids: [...parentIDs] });
    }
    const ids = fuseRecallBuckets(buckets, MAX_FULLTEXT_DISCOVERY_CANDIDATES);
    const selected = new Set(ids);
    for (const id of hitsByParentID.keys()) {
      if (!selected.has(id)) hitsByParentID.delete(id);
    }
    return { ids, hitsByParentID };
  }

  private async recallExactTitles(
    libraryID: number,
    titles: string[],
  ): Promise<number[]> {
    const ids = new Set<number>();
    for (const title of titles.slice(0, 4)) {
      const normalized = title.trim();
      if (!normalized) continue;
      const variants = [normalized, ...titleFragments(normalized)];
      for (const [index, variant] of variants.entries()) {
        const operators =
          index === 0 ? (["is", "contains"] as const) : (["contains"] as const);
        for (const operator of operators) {
          const search = new Zotero.Search();
          (search as any).libraryID = libraryID;
          search.addCondition("title", operator, variant);
          search.addCondition("noChildren", "true");
          try {
            for (const id of validItemIDs(await search.search())) ids.add(id);
          } catch (error) {
            Zotero.logError(
              new Error(`ZaiChat exact-title search failed: ${safeError(error)}`),
            );
          }
        }
      }
      const tokenHits = new Map<number, number>();
      const tokens = titleRecallTokens(normalized);
      for (const token of tokens) {
        const search = new Zotero.Search();
        (search as any).libraryID = libraryID;
        search.addCondition("title", "contains", token);
        search.addCondition("noChildren", "true");
        try {
          for (const id of validItemIDs(await search.search()))
            tokenHits.set(id, (tokenHits.get(id) || 0) + 1);
        } catch (error) {
          Zotero.logError(
            new Error(`ZaiChat title-token search failed: ${safeError(error)}`),
          );
        }
      }
      const minimumCoverage = Math.max(2, Math.ceil(tokens.length * 0.55));
      for (const [id, hits] of tokenHits) if (hits >= minimumCoverage) ids.add(id);
    }
    return [...ids].slice(0, 50);
  }

  private async toDocument(item: Zotero.Item): Promise<SearchDocument> {
    const readWarnings: string[] = [];
    const read = <T>(field: string, getter: () => T, fallback: T): T => {
      try {
        return getter();
      } catch (error) {
        readWarnings.push(field);
        Zotero.logError(
          new Error(`ZaiChat metadata field ${field} failed: ${safeError(error)}`),
        );
        return fallback;
      }
    };
    const readChildren = async (
      field: string,
      getter: () => Promise<Array<{ text: string }>>,
    ) => {
      try {
        return await getter();
      } catch (error) {
        readWarnings.push(field);
        Zotero.logError(
          new Error(`ZaiChat metadata field ${field} failed: ${safeError(error)}`),
        );
        return [];
      }
    };
    const get = (field: string) =>
      read(field, () => String(item.getField(field as any, false, true) || ""), "");
    const ref = { libraryID: item.libraryID, itemKey: item.key };
    const creators = read("authors", () => item.getCreators?.() || [], []);
    const childNotes = await readChildren("notes", () => this.listNotes(ref));
    const childAnnotations = await readChildren("annotations", () =>
      this.listAnnotations(ref),
    );
    return {
      readWarnings,
      item: ref,
      title:
        get("title") ||
        read("displayTitle", () => String((item as any).getDisplayTitle?.() || ""), ""),
      abstract: get("abstractNote"),
      authors: creators
        .map((creator: any) =>
          [creator.firstName, creator.lastName].filter(Boolean).join(" "),
        )
        .filter(Boolean),
      tags: read(
        "tags",
        () =>
          (item.getTags?.() || [])
            .map((tag: any) => String(tag.tag || ""))
            .filter(Boolean),
        [],
      ),
      year: extractYear(get("date")),
      date: get("date"),
      publicationTitle: get("publicationTitle"),
      doi: get("DOI"),
      itemType: String((Zotero.ItemTypes as any).getName?.(item.itemTypeID) || ""),
      language: get("language"),
      collections: read(
        "collections",
        () =>
          (item.getCollections?.() || [])
            .map((id: number) => Zotero.Collections.get(id)?.key)
            .filter(Boolean) as string[],
        [],
      ),
      notes: childNotes.map((note) => note.text),
      annotations: childAnnotations.map((annotation) => annotation.text),
      attachmentRefs: read(
        "attachments",
        () =>
          ((item as any).getAttachments?.() || [])
            .map((id: number) => Zotero.Items.get(id))
            .filter(Boolean)
            .map((attachment: Zotero.Item) => this.ref(attachment)),
        [],
      ),
    };
  }

  private async readIndexedText(attachment: Zotero.Item): Promise<string> {
    try {
      const cacheFile = (Zotero.Fulltext as any).getItemCacheFile?.(attachment);
      const path = cacheFile?.path || cacheFile;
      if (!path || !(await IOUtils.exists(path))) return "";
      return clip(
        (await Zotero.File.getContentsAsync(path)) as string,
        MAX_ATTACHMENT_TEXT_CHARS,
      );
    } catch {
      return "";
    }
  }

  private toSource(
    item: RetrievedItem,
    field?: EvidenceSnippet["field"],
  ): SourceReference {
    return {
      sourceID: createID("src"),
      item: item.item,
      attachment: item.attachmentRefs?.[0],
      label: item.title,
      field: field || item.matchedFields[0],
    };
  }

  private toCandidate(
    item: RetrievedItem,
    indexState?: string,
    sourceID?: string,
    previewTerms: string[] = [],
  ): RetrievalCandidate {
    return {
      sourceID,
      readWarnings: item.readWarnings,
      item: item.item,
      title: item.title,
      authors: item.authors.slice(0, 12),
      authorCount: item.readWarnings?.includes("authors") ? null : item.authors.length,
      authorsTruncated:
        item.readWarnings?.includes("authors") || item.authors.length > 12,
      year: item.year,
      date: item.date,
      publicationTitle: item.publicationTitle,
      doi: item.doi,
      itemType: item.itemType,
      language: item.language,
      tags: item.tags.slice(0, 20),
      abstractExcerpt: candidateExcerpt(
        item.abstract,
        previewTerms,
        MAX_ABSTRACT_EXCERPT_CHARS,
      ),
      fulltextMatchTerms: (item.fulltextMatchTerms || [])
        .slice(0, 12)
        .map((term) => clip(term, 120)),
      attachmentRefs: (item.attachmentRefs || []).slice(0, 8),
      provenance: [...new Set(item.provenance || [])],
      score: item.score,
      matchedFields: item.matchedFields,
      indexState,
    };
  }

  ref(item: Zotero.Item): ZoteroObjectRef {
    let title = "";
    try {
      title = String(item.getField("title" as any, false, true) || "");
    } catch {
      // Notes and annotations do not expose the regular-item title field.
    }
    title ||= String((item as any).getDisplayTitle?.() || "");
    title ||= stripHTML(
      String(
        (item as any).annotationText ||
          (item as any).annotationComment ||
          (item as any).getNote?.() ||
          "",
      ),
    );
    return {
      libraryID: item.libraryID,
      itemKey: item.key,
      itemType: String((Zotero.ItemTypes as any).getName?.(item.itemTypeID) || ""),
      title: clip(title, 160),
    };
  }
}

export function semanticQueryTexts(
  query: RetrievalQuery,
  userQuery = "",
  limit?: number,
): string[] {
  const rememberedItem = query.intent === "remembered_item";
  const expandedRemembered = rememberedItem && limit === undefined;
  const routeLimit = Math.min(32, Math.max(1, limit ?? (expandedRemembered ? 32 : 14)));
  const families: SemanticRouteFamily[] = [
    { id: "exact-title", values: query.exactTitles || [], quota: 2, weight: 4 },
    { id: "user", values: userQuery ? [userQuery] : [], quota: 1, weight: 3.4 },
    { id: "literal-user", values: literalUserTerms(userQuery), quota: 4, weight: 3.4 },
    {
      id: "title",
      values: expandedRemembered
        ? anchoredPlannerRoutes(query, query.titleHypotheses || [])
        : query.titleHypotheses || [],
      quota: expandedRemembered ? 8 : 2,
      weight: 3.2,
    },
    {
      id: "english",
      values: expandedRemembered
        ? anchoredPlannerRoutes(query, query.englishQueries || [])
        : query.englishQueries || [],
      quota: expandedRemembered ? 3 : 2,
      weight: 3,
    },
    {
      id: "combination",
      values: expandedRemembered
        ? anchoredPlannerRoutes(query, query.searchCombinations || [])
        : query.searchCombinations || [],
      quota: expandedRemembered ? 3 : 3,
      weight: 3.3,
    },
    {
      id: "composed-concepts",
      values: composeSemanticConceptRoutes(query),
      quota: expandedRemembered ? 24 : 4,
      weight: 3.5,
    },
    {
      id: "meaning",
      values: (query.concepts || []).map((concept) => concept.meaning),
      quota: 1,
      weight: 2.4,
    },
    {
      id: "variant",
      values: (query.concepts || []).flatMap((concept) =>
        concept.variants
          .filter((variant) => variant.confidence !== "low")
          .map((variant) => variant.term),
      ),
      quota: 2,
      weight: 2.6,
    },
  ];
  const candidates = normalizeSemanticRouteCandidates(families);
  const selected: SemanticRouteCandidate[] = [];
  const familyCounts = new Map<string, number>();

  // Preserve exact/user wording. A remembered-item plan has only a few bounded
  // title hypotheses, and each one represents a distinct interpretation of an
  // uncertain memory. Search all of them before spending the remaining local
  // embedding calls on information-gain selection.
  for (const familyID of ["exact-title", "user", "literal-user"]) {
    const seed = candidates.find(
      (candidate) => candidate.familyID === familyID && !selected.includes(candidate),
    );
    if (seed && selected.length < routeLimit)
      addSemanticRoute(seed, selected, familyCounts);
  }
  if (expandedRemembered) {
    // Reserve an independent route from each family before any family consumes
    // the remaining budget. More paraphrases must not remove another meaning.
    for (const familyID of [
      "english",
      "combination",
      "meaning",
      "composed-concepts",
      "variant",
    ]) {
      const seed = candidates.find(
        (entry) => entry.familyID === familyID && !selected.includes(entry),
      );
      if (seed && selected.length < routeLimit)
        addSemanticRoute(seed, selected, familyCounts);
    }
    for (const candidate of candidates.filter((entry) => entry.familyID === "title")) {
      if (selected.length >= routeLimit) break;
      addSemanticRoute(candidate, selected, familyCounts);
    }
    // The model supplies the terminology graph; the plugin deterministically
    // exercises its independent lexical families. Seed these contrastive,
    // all-concept routes before broad single-term evidence so a synonym that
    // the planner listed cannot silently disappear from actual retrieval.
    for (const candidate of candidates.filter(
      (entry) => entry.familyID === "composed-concepts",
    )) {
      if (selected.length >= routeLimit) break;
      if (selected.includes(candidate)) continue;
      addSemanticRoute(candidate, selected, familyCounts);
    }
  }
  while (selected.length < routeLimit) {
    const eligible = candidates.filter(
      (candidate) =>
        !selected.includes(candidate) &&
        (familyCounts.get(candidate.familyID) || 0) < candidate.quota,
    );
    if (!eligible.length) break;
    eligible.sort(
      (left, right) =>
        semanticRouteUtility(right, selected, familyCounts) -
          semanticRouteUtility(left, selected, familyCounts) ||
        left.position - right.position ||
        left.value.localeCompare(right.value),
    );
    addSemanticRoute(eligible[0], selected, familyCounts);
  }
  return selected.map((candidate) => candidate.value);
}

interface SemanticRouteFamily {
  id: string;
  values: string[];
  quota: number;
  weight: number;
}

interface SemanticRouteCandidate {
  value: string;
  key: string;
  tokens: Set<string>;
  familyID: string;
  quota: number;
  weight: number;
  position: number;
}

function normalizeSemanticRouteCandidates(
  families: SemanticRouteFamily[],
): SemanticRouteCandidate[] {
  const seen = new Set<string>();
  const candidates: SemanticRouteCandidate[] = [];
  for (const family of families) {
    family.values.forEach((rawValue, position) => {
      if (typeof rawValue !== "string") return;
      const value = rawValue
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600);
      const key = value.toLocaleLowerCase();
      if (!value || seen.has(key)) return;
      seen.add(key);
      candidates.push({
        value,
        key,
        tokens: new Set(normalizeText(value).match(/[\p{L}\p{N}]+/gu) || []),
        familyID: family.id,
        quota: family.quota,
        weight: family.weight,
        position,
      });
    });
  }
  return candidates;
}

function composeSemanticConceptRoutes(query: RetrievalQuery): string[] {
  const concepts = (query.concepts || []).filter(
    (concept) => concept.role === "required" && concept.variants.length,
  );
  if (concepts.length < 2) return [];
  const terms = concepts.map((concept) => semanticConceptTerms(concept, query.intent));
  if (terms.some((values) => !values.length)) return [];
  const routes: string[] = [];
  const seen = new Set<string>();
  const add = (values: string[]) => {
    const route = values.join(" ").replace(/\s+/g, " ").trim();
    const key = normalizeText(route);
    if (!route || seen.has(key) || routes.length >= 48) return;
    seen.add(key);
    routes.push(route);
  };
  const primary = terms.map((values) => values[0]);
  add(primary);
  const maximumAlternatives = Math.max(...terms.map((values) => values.length - 1));
  for (let alternative = 1; alternative <= maximumAlternatives; alternative++) {
    // First vary one concept at a time. This measures the marginal value of
    // each lexical family while retaining every other explicit user concept.
    for (let conceptIndex = 0; conceptIndex < terms.length; conceptIndex++) {
      if (!terms[conceptIndex][alternative]) continue;
      const values = [...primary];
      values[conceptIndex] = terms[conceptIndex][alternative];
      add(values);
    }
    // Then vary concept pairs. This covers interactions such as an alternate
    // event structure plus an alternate scholarly noun without an unbounded
    // Cartesian product or any domain-specific vocabulary.
    for (let left = 0; left < terms.length - 1; left++) {
      for (let right = left + 1; right < terms.length; right++) {
        if (!terms[left][alternative] && !terms[right][alternative]) continue;
        const values = [...primary];
        values[left] = terms[left][alternative] || terms[left].at(-1) || primary[left];
        values[right] =
          terms[right][alternative] || terms[right].at(-1) || primary[right];
        add(values);
      }
    }
    if (routes.length >= 48) break;
  }
  return routes;
}

function semanticConceptTerms(
  concept: NonNullable<RetrievalQuery["concepts"]>[number],
  intent: RetrievalQuery["intent"] = "topic",
): string[] {
  return (
    concept.variants
      // Related, broader, and narrower concepts are discovery hints, not
      // interchangeable wording for an explicit required concept. Never let
      // them replace that anchor inside an all-concept semantic route.
      .filter(
        (variant) =>
          !["related_term", "broader_term", "narrower_term"].includes(
            variant.relation,
          ) &&
          (intent === "remembered_item" || variant.confidence !== "low"),
      )
      .sort(
        (left, right) =>
          Number(hasLatinTerm(right.term)) - Number(hasLatinTerm(left.term)) ||
          semanticConfidenceWeight(right.confidence) -
            semanticConfidenceWeight(left.confidence) ||
          left.term.localeCompare(right.term),
      )
      .map((variant) => variant.term)
      .filter((term, index, values) => {
        const key = semanticTermFamilyKey(term);
        return (
          key.length >= 2 &&
          values.findIndex((value) => semanticTermFamilyKey(value) === key) === index
        );
      })
      .slice(0, intent === "remembered_item" ? 8 : 6)
  );
}

function anchoredPlannerRoutes(query: RetrievalQuery, values: string[]): string[] {
  if (query.intent !== "remembered_item") return values;
  const required = (query.concepts || []).filter(
    (concept) => concept.role === "required",
  );
  return values.filter((value) =>
    required.every((concept) => {
      const anchors = semanticConceptTerms(concept, query.intent).filter(hasLatinTerm);
      return (
        !anchors.length ||
        anchors.some((term) => semanticTermCoverage(value, term) >= 0.67)
      );
    }),
  );
}

function semanticTermCoverage(text: string, term: string): number {
  const textTokens = new Set(semanticTermFamilyKey(text).split(" ").filter(Boolean));
  const termTokens = semanticTermFamilyKey(term).split(" ").filter(Boolean);
  if (!termTokens.length) return 0;
  return termTokens.filter((token) => textTokens.has(token)).length / termTokens.length;
}

function semanticTermFamilyKey(value: string): string {
  return (normalizeText(value).match(/[a-z0-9][a-z0-9-]*/gu) || [])
    .map((token) => {
      let result = token.replace(/-/g, "");
      if (result.length > 6)
        result = result.replace(/(ically|edly|ingly|ally|ness)$/u, "");
      if (result.length > 4) result = result.replace(/(ing|ed|ies|es|s)$/u, "");
      if (result.endsWith("e") && result.length > 5) result = result.slice(0, -1);
      return result;
    })
    .filter(Boolean)
    .join(" ");
}

function hasLatinTerm(value: string): boolean {
  return /[a-z][a-z-]{1,}/iu.test(value);
}

function semanticConfidenceWeight(confidence: "high" | "medium" | "low"): number {
  return confidence === "high" ? 2 : confidence === "medium" ? 1 : 0;
}

function semanticRouteUtility(
  candidate: SemanticRouteCandidate,
  selected: SemanticRouteCandidate[],
  familyCounts: Map<string, number>,
): number {
  const maximumOverlap = Math.max(
    0,
    ...selected.map((existing) => tokenJaccard(candidate.tokens, existing.tokens)),
  );
  const familyCount = familyCounts.get(candidate.familyID) || 0;
  const specificity = Math.min(8, candidate.tokens.size) / 8;
  const excessiveLengthPenalty = Math.max(0, candidate.value.length - 240) / 600;
  return (
    candidate.weight +
    (1 - maximumOverlap) * 2.4 +
    (familyCount ? 0 : 0.8) +
    specificity * 0.4 -
    familyCount * 0.35 -
    excessiveLengthPenalty -
    candidate.position * 0.005
  );
}

function tokenJaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function addSemanticRoute(
  candidate: SemanticRouteCandidate,
  selected: SemanticRouteCandidate[],
  familyCounts: Map<string, number>,
): void {
  selected.push(candidate);
  familyCounts.set(candidate.familyID, (familyCounts.get(candidate.familyID) || 0) + 1);
}

export function semanticQueryText(query: RetrievalQuery, userQuery = ""): string {
  return semanticQueryTexts(query, userQuery, 1)[0] || "";
}

export function fuseSemanticRouteResults(
  routes: PaperSemanticSearchResult[][],
  limit = 60,
): PaperSemanticSearchResult[] {
  const entries = new Map<
    string,
    {
      hit: PaperSemanticSearchResult;
      rrf: number;
      bestRank: number;
    }
  >();
  for (const route of routes) {
    const seen = new Set<string>();
    route.forEach((hit, index) => {
      const key = `${hit.libraryID}:${hit.itemKey}`;
      if (seen.has(key)) return;
      seen.add(key);
      const current = entries.get(key) || {
        hit: { ...hit, sourceFields: [...hit.sourceFields] },
        rrf: 0,
        bestRank: Number.POSITIVE_INFINITY,
      };
      current.rrf += 1 / (60 + index + 1);
      current.bestRank = Math.min(current.bestRank, index + 1);
      if (hit.score > current.hit.score) current.hit.score = hit.score;
      current.hit.sourceFields = [
        ...new Set([...current.hit.sourceFields, ...hit.sourceFields]),
      ];
      entries.set(key, current);
    });
  }
  return [...entries.values()]
    .sort(
      (left, right) =>
        right.rrf - left.rrf ||
        left.bestRank - right.bestRank ||
        right.hit.score - left.hit.score ||
        left.hit.itemKey.localeCompare(right.hit.itemKey),
    )
    .slice(0, Math.min(180, Math.max(1, limit)))
    .map((entry) => entry.hit);
}

export function fuseHybridResults(
  lexical: RetrievedItem[],
  semantic: RetrievedItem[],
  limit: number,
  semanticReserveFraction = 0.55,
  exactTitles: string[] = [],
): RetrievedItem[] {
  const entries = new Map<
    string,
    { item: RetrievedItem; rrf: number; lexicalScore: number; semanticScore: number }
  >();
  const add = (
    items: RetrievedItem[],
    weight: number,
    source: "lexical" | "semantic",
  ) =>
    items.forEach((item, index) => {
      const key = `${item.item.libraryID}:${item.item.itemKey}`;
      const current = entries.get(key) || {
        item,
        rrf: 0,
        lexicalScore: 0,
        semanticScore: 0,
      };
      current.rrf += weight / (60 + index + 1);
      if (source === "lexical") current.lexicalScore = item.score;
      else current.semanticScore = item.score;
      current.item = mergeRetrievedItems(current.item, item);
      entries.set(key, current);
    });
  add(lexical, 1, "lexical");
  add(semantic, 1.1, "semantic");
  const highestRRF = Math.max(0, ...[...entries.values()].map((entry) => entry.rrf));
  const ranked = [...entries.values()].sort(
    (left, right) =>
      right.rrf - left.rrf ||
      right.semanticScore - left.semanticScore ||
      right.lexicalScore - left.lexicalScore ||
      left.item.title.localeCompare(right.item.title),
  );
  const boundedLimit = Math.min(50, Math.max(1, limit));
  const semanticReserveCount = Math.min(
    semantic.length,
    boundedLimit,
    Math.max(
      4,
      Math.ceil(boundedLimit * Math.min(0.9, Math.max(0.1, semanticReserveFraction))),
    ),
  );
  const reservedSemanticKeys = new Set(
    semantic
      .slice(0, semanticReserveCount)
      .map((item) => `${item.item.libraryID}:${item.item.itemKey}`),
  );
  const normalizedTitles = new Set(exactTitles.map(normalizeText));
  const exactEntries = ranked
    .filter((entry) => normalizedTitles.has(normalizeText(entry.item.title)))
    .slice(0, boundedLimit);
  const selectedKeys = new Set(
    exactEntries.map(
      (entry) => `${entry.item.item.libraryID}:${entry.item.item.itemKey}`,
    ),
  );
  for (const key of reservedSemanticKeys) {
    if (selectedKeys.size >= boundedLimit) break;
    selectedKeys.add(key);
  }
  for (const entry of ranked) {
    if (selectedKeys.size >= boundedLimit) break;
    selectedKeys.add(`${entry.item.item.libraryID}:${entry.item.item.itemKey}`);
  }
  // Exact identities precede fuzzy matches, including before the later evidence-budget cut.
  return [...exactEntries, ...ranked.filter((entry) => !exactEntries.includes(entry))]
    .filter((entry) =>
      selectedKeys.has(`${entry.item.item.libraryID}:${entry.item.item.itemKey}`),
    )
    .slice(0, boundedLimit)
    .map((entry) => ({
      ...entry.item,
      score: highestRRF ? Math.min(1, entry.rrf / highestRRF) : entry.item.score,
    }));
}

function mergeRetrievedItems(left: RetrievedItem, right: RetrievedItem): RetrievedItem {
  return {
    ...(left.abstract || left.title ? left : right),
    provenance: [...new Set([...(left.provenance || []), ...(right.provenance || [])])],
    matchedFields: [...new Set([...left.matchedFields, ...right.matchedFields])],
    score: Math.max(left.score, right.score),
  };
}

function semanticFieldToEvidenceField(
  field: PaperSemanticSearchResult["sourceFields"][number],
): EvidenceSnippet["field"] {
  return field === "tags" ? "tag" : field;
}

export function fulltextDiscoveryTerms(
  query: RetrievalQuery,
  limit = MAX_FULLTEXT_DISCOVERY_ROUTES,
  userQuery = "",
): string[] {
  return [
    ...new Set(
      [...literalUserTerms(userQuery), ...recallTerms(query, Math.max(0, limit))]
        .map(normalizeText)
        .filter((term) => term.length >= 3),
    ),
  ].slice(0, Math.max(0, limit));
}

// Preserve literal Latin-script terms in mixed-language requests and quoted
// phrases. They are exploratory routes, never inferred corrections or filters.
export function literalUserTerms(userQuery: string): string[] {
  const quoted = [...userQuery.matchAll(/["“]([^"”]{3,120})["”]/gu)].map(
    (match) => match[1],
  );
  const mixedLanguage = /[\u3400-\u9fff]/u.test(userQuery);
  const latin = mixedLanguage
    ? userQuery.match(/[A-Za-z][A-Za-z0-9_-]*(?:[ \t]+[A-Za-z][A-Za-z0-9_-]*)*/g) || []
    : [];
  return [...new Set([...quoted, ...latin].map(normalizeText))]
    .filter((term) => term.length >= 3 && term.length <= 120)
    .slice(0, 4);
}

function titleFragments(title: string): string[] {
  const words = title.match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length < 8) return [];
  const size = Math.min(8, Math.max(5, Math.floor(words.length / 2)));
  return [words.slice(0, size).join(" "), words.slice(-size).join(" ")].filter(
    (value, index, values) => value.length >= 20 && values.indexOf(value) === index,
  );
}

export function titleRecallTokens(title: string): string[] {
  const tokens = (title.toLocaleLowerCase().match(/[a-z][a-z-]{2,}/g) || []).filter(
    (token) => !TITLE_STOPWORDS.has(token),
  );
  return [...new Set(tokens)]
    .sort((left, right) => right.length - left.length)
    .slice(0, 10);
}

const TITLE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "with",
  "into",
  "that",
  "this",
  "are",
  "was",
  "has",
  "have",
]);

export function extractSnippets(
  text: string,
  terms: string[],
  limit = 4,
  maxChars = 800,
): string[] {
  if (!text.trim()) return [];
  const normalizedTerms = terms
    .map((term) => term.trim().toLocaleLowerCase())
    .filter(Boolean);
  const lower = text.toLocaleLowerCase();
  const positions = normalizedTerms
    .flatMap((term) => {
      const values: number[] = [];
      let offset = 0;
      while (values.length < limit * 2) {
        const found = lower.indexOf(term, offset);
        if (found < 0) break;
        values.push(found);
        offset = found + Math.max(1, term.length);
      }
      return values;
    })
    .sort((a, b) => a - b);
  const windows: Array<[number, number]> = [];
  for (const position of positions) {
    const start = Math.max(0, position - Math.floor(maxChars / 2));
    const end = Math.min(text.length, start + maxChars);
    const previous = windows[windows.length - 1];
    if (previous && start <= previous[1])
      previous[1] = Math.min(text.length, Math.max(previous[1], end));
    else windows.push([start, end]);
    if (windows.length >= limit) break;
  }
  // With explicit search terms, a non-matching cache prefix is not evidence.
  // Only use the beginning of the attachment when the caller deliberately
  // requested a term-free preview.
  if (!windows.length) {
    if (normalizedTerms.length) return [];
    windows.push([0, Math.min(text.length, maxChars)]);
  }
  return windows
    .slice(0, limit)
    .map(([start, end]) =>
      text
        .slice(start, Math.min(end, start + maxChars))
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

function stripHTML(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
function extractYear(value: string): number | undefined {
  const match = value.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

export function validItemIDs(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function dedupeObjectRefs(refs: ZoteroObjectRef[]): ZoteroObjectRef[] {
  return [
    ...new Map(
      refs.map((ref) => [`${ref.libraryID}:${ref.itemKey}`, ref] as const),
    ).values(),
  ];
}

function markProvenance(
  provenanceByID: Map<number, Set<RetrievalProvenance>>,
  id: number,
  provenance: RetrievalProvenance,
): void {
  const values = provenanceByID.get(id) || new Set<RetrievalProvenance>();
  values.add(provenance);
  provenanceByID.set(id, values);
}

export function interleaveUniqueIDs(buckets: number[][], limit: number): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  const longest = Math.max(0, ...buckets.map((bucket) => bucket.length));
  for (let offset = 0; offset < longest && result.length < limit; offset++) {
    for (const bucket of buckets) {
      const id = bucket[offset];
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
      if (result.length >= limit) break;
    }
  }
  return result;
}

export interface RecallBucket {
  term: string;
  ids: number[];
}

/**
 * Fuse bounded Zotero-search routes before loading item metadata. Reciprocal-rank
 * fusion keeps strong results from a single precise phrase, while route coverage
 * promotes items independently reached through several concept families. This
 * avoids discarding an item merely because it appears deep in a broad-term list.
 */
export function fuseRecallBuckets(buckets: RecallBucket[], limit: number): number[] {
  const scores = new Map<
    number,
    { routeScore: number; rrf: number; bestRank: number }
  >();
  for (const bucket of buckets) {
    const routeWeight = recallRouteWeight(bucket.term);
    const seenInRoute = new Set<number>();
    bucket.ids.forEach((rawID, index) => {
      const id = Number(rawID);
      if (!Number.isInteger(id) || id <= 0 || seenInRoute.has(id)) return;
      seenInRoute.add(id);
      const previous = scores.get(id) || {
        routeScore: 0,
        rrf: 0,
        bestRank: Number.POSITIVE_INFINITY,
      };
      previous.routeScore += routeWeight;
      previous.rrf += routeWeight / (60 + index + 1);
      previous.bestRank = Math.min(previous.bestRank, index);
      scores.set(id, previous);
    });
  }
  return [...scores]
    .sort(
      ([leftID, left], [rightID, right]) =>
        right.routeScore - left.routeScore ||
        right.rrf - left.rrf ||
        left.bestRank - right.bestRank ||
        leftID - rightID,
    )
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
}

function recallRouteWeight(term: string): number {
  const wordCount = term.match(/[a-z0-9][a-z0-9-]*|[\u3400-\u9fff]+/giu)?.length || 1;
  return 1 + Math.min(2, Math.max(0, wordCount - 1)) * 0.25;
}
