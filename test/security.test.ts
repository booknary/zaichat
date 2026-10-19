import { describe, expect, it, vi } from "vitest";
import {
  isAllowedBaseURL,
  isDeepSeekProfile,
  normalizeModelProfile,
} from "../src/utils/prefs";
import {
  redactSecrets,
  sanitizeMarkdown,
  sanitizeNoteHTML,
  sanitizeTag,
} from "../src/utils/sanitize";
import { extractSnippets } from "../src/host/zoteroRetriever";
import type { RetrievedItem } from "../src/core/types";

describe("security boundaries", () => {
  it("allows HTTPS and local HTTP only", () => {
    expect(isAllowedBaseURL("https://api.example.com/v1")).toBe(true);
    expect(isAllowedBaseURL("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isAllowedBaseURL("http://example.com/v1")).toBe(false);
    expect(
      normalizeModelProfile({ id: "x", baseURL: "http://example.com", model: "x" }),
    ).toBeUndefined();
  });

  it("normalizes generic and DeepSeek reasoning effort choices", () => {
    const generic = normalizeModelProfile({
      id: "generic",
      baseURL: "https://api.example.com/v1",
      model: "reasoning-model",
      reasoningEffort: "max",
    });
    const deepSeek = normalizeModelProfile({
      id: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      reasoningEffort: "medium",
    });
    expect(generic?.reasoningEffort).toBe("max");
    expect(deepSeek?.reasoningEffort).toBe("high");
    expect(isDeepSeekProfile(deepSeek || {})).toBe(true);
  });

  it("sanitizes notes, markdown, tags and secrets", () => {
    expect(
      sanitizeNoteHTML('<p onclick="bad()">ok</p><script>bad()</script>'),
    ).not.toMatch(/onclick|script/i);
    expect(sanitizeMarkdown("[x](javascript:alert(1))")).not.toContain("javascript:");
    expect(sanitizeTag("  alpha\n beta ")).toBe("alpha beta");
    expect(redactSecrets("Bearer secret", ["secret"])).toBe("Bearer [REDACTED]");
  });

  it("preserves statistical inequalities and all text between them", () => {
    const text = "P<0.01，两类均显著；再逐基因比较 P<0.01，effect>1；x < 2 and y > 3";
    expect(sanitizeMarkdown(text)).toBe(text);
    expect(sanitizeMarkdown(sanitizeMarkdown(text))).toBe(text);
    expect(sanitizeMarkdown("95% CI: -1 < estimate < 2; n > 10")).toBe(
      "95% CI: -1 < estimate < 2; n > 10",
    );
  });

  it("still strips HTML tags with attributes and blocks executable links", () => {
    expect(sanitizeMarkdown('<b class="x">P<0.01</b> and effect>1')).toBe(
      "P<0.01 and effect>1",
    );
    const cleaned = sanitizeMarkdown(
      '<!-- hidden --><img src="x" onerror="bad()"><script>bad()</script>[x](javascript:bad)',
    );
    expect(cleaned).not.toMatch(/<img|<script|onerror|javascript:|hidden/i);
  });

  it("bounds full-text snippets", () => {
    const snippets = extractSnippets(
      "x".repeat(500) + "protein" + "y".repeat(500),
      ["protein"],
      4,
      120,
    );
    expect(snippets).toHaveLength(1);
    expect(snippets[0].length).toBeLessThanOrEqual(120);
    expect(snippets[0]).toContain("protein");
    expect(extractSnippets("unrelated cache text", ["protein"], 4, 120)).toEqual([]);
  });

  it("passes the attachment item to Zotero's indexed-state API", async () => {
    const module = await import("../src/host/zoteroRetriever");
    const previousZotero = (globalThis as any).Zotero;
    const previousIOUtils = (globalThis as any).IOUtils;
    const attachment = {
      id: 101,
      libraryID: 1,
      key: "ATTACH01",
      parentItemID: 10,
      itemTypeID: 14,
      isAttachment: () => true,
    };
    const parent = {
      libraryID: 1,
      key: "PARENT01",
      itemTypeID: 2,
      getField: () => "Parent paper",
    };
    const getIndexedState = vi.fn(async (item: any) => {
      if (!item.isAttachment()) throw new Error("Item is not an attachment");
      return 2;
    });
    (globalThis as any).Zotero = {
      Items: {
        getByLibraryAndKey: () => attachment,
        getAsync: async () => parent,
      },
      ItemTypes: { getName: () => "journalArticle" },
      Fulltext: { getIndexedState, getItemCacheFile: () => ({ path: "test-cache" }) },
      File: { getContentsAsync: async () => "genome innovation burst" },
    };
    (globalThis as any).IOUtils = { exists: async () => true };
    try {
      const retriever = new module.ZoteroRetriever() as any;
      const snippets = await retriever.readSnippets(
        [{ libraryID: 1, itemKey: "ATTACH01" }],
        ["genome innovation"],
        1,
        1,
        200,
      );
      expect(snippets).toHaveLength(1);
      expect(snippets[0].indexState).toBe("2");
      expect(getIndexedState).toHaveBeenCalledWith(attachment);
      expect(snippets[0].coverage).toEqual({
        cacheChars: 23,
        scannedChars: 23,
        truncated: false,
      });
    } finally {
      (globalThis as any).Zotero = previousZotero;
      (globalThis as any).IOUtils = previousIOUtils;
    }
  });

  it("does not expose local full-text buffers in compact candidates", async () => {
    const module = await import("../src/host/zoteroRetriever");
    const retriever = new module.ZoteroRetriever() as any;
    const item: RetrievedItem = {
      item: { libraryID: 1, itemKey: "A" },
      title: "Paper",
      abstract: "a".repeat(2000),
      authors: ["Author"],
      tags: ["tag"],
      attachmentRefs: [{ libraryID: 1, itemKey: "ATT" }],
      fulltext: ["SECRET-FULLTEXT".repeat(10_000)],
      fulltextMatchTerms: Array.from({ length: 30 }, (_, index) =>
        `bounded-method-${index}`.repeat(20),
      ),
      notes: ["local note"],
      annotations: ["local annotation"],
      score: 1,
      matchedFields: ["fulltext"],
    };
    const compact = retriever.toCandidate(item, "indexed");
    const serialized = JSON.stringify(compact);
    expect(serialized).not.toContain("SECRET-FULLTEXT");
    expect(serialized).not.toContain("local note");
    expect(serialized).not.toContain("local annotation");
    expect(compact.abstractExcerpt.length).toBeLessThanOrEqual(600);
    expect(compact.fulltextMatchTerms).toHaveLength(12);
    expect(compact.fulltextMatchTerms.every((term: string) => term.length <= 120)).toBe(
      true,
    );
  });

  it("creates references for notes and annotations without a title field", async () => {
    const module = await import("../src/host/zoteroRetriever");
    const previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
      ItemTypes: { getName: () => "annotation" },
    };
    try {
      const retriever = new module.ZoteroRetriever();
      const ref = retriever.ref({
        libraryID: 1,
        key: "ANNOT01",
        itemTypeID: 99,
        annotationText: "Relevant highlighted passage",
        getField: () => {
          throw new Error("Invalid field title for annotation");
        },
      } as any);
      expect(ref.title).toBe("Relevant highlighted passage");
    } finally {
      (globalThis as any).Zotero = previousZotero;
    }
  });
});
