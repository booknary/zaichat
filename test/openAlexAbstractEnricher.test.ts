import { describe, expect, it, vi } from "vitest";
import {
  AbstractEnrichmentCache,
  AbstractEnrichmentCacheEntry,
  invertedAbstract,
  OpenAlexAbstractEnricher,
  titlesAgree,
} from "../src/semantic/openAlexAbstractEnricher";
import { PaperSemanticSource } from "../src/semantic/types";

describe("OpenAlexAbstractEnricher", () => {
  it("fills a missing abstract from an exact DOI after title verification", async () => {
    const cache = new MemoryCache();
    const fetchJSON = vi.fn(async () => ({
      results: [
        {
          doi: "https://doi.org/10.1234/example",
          title: "Recurring stellar flares reveal an unseen companion",
          abstract_inverted_index: {
            Repeated: [0],
            observations: [1],
            reveal: [2],
            a: [3],
            companion: [4],
          },
        },
      ],
    }));
    const enricher = new OpenAlexAbstractEnricher(cache, {
      enabled: () => true,
      fetchJSON,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    const enriched = await enricher.enrich(source());

    expect(enriched.abstract).toBe("Repeated observations reveal a companion");
    expect(enriched.abstractSource).toBe("openalex");
    expect(fetchJSON).toHaveBeenCalledTimes(1);
    expect(cache.entries[0]).toMatchObject({
      doi: "10.1234/example",
      source: "openalex",
    });
  });

  it("never replaces a Zotero abstract or accepts a mismatched title", async () => {
    const fetchJSON = vi.fn(async () => ({
      results: [
        {
          doi: "https://doi.org/10.1234/example",
          title: "An unrelated clinical trial",
          abstract_inverted_index: { Wrong: [0], abstract: [1] },
        },
      ],
    }));
    const enricher = new OpenAlexAbstractEnricher(new MemoryCache(), {
      enabled: () => true,
      fetchJSON,
    });

    expect((await enricher.enrich(source())).abstract).toBe("");
    expect(
      (
        await enricher.enrich({
          ...source(),
          abstract: "Curated Zotero abstract",
          abstractSource: "zotero",
        })
      ).abstract,
    ).toBe("Curated Zotero abstract");
    expect(fetchJSON).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the option is disabled", async () => {
    const fetchJSON = vi.fn();
    const enricher = new OpenAlexAbstractEnricher(new MemoryCache(), {
      enabled: () => false,
      fetchJSON,
    });
    expect(await enricher.enrich(source())).toEqual(source());
    expect(fetchJSON).not.toHaveBeenCalled();
  });

  it("reconstructs inverted abstracts and compares titles generically", () => {
    expect(invertedAbstract({ second: [1], first: [0], again: [2, 4] })).toBe(
      "first second again again",
    );
    expect(
      titlesAgree(
        "Recurring stellar flares reveal an unseen companion",
        "Recurring stellar flares reveal an unseen companion",
      ),
    ).toBe(true);
    expect(
      titlesAgree(
        "Recurring stellar flares reveal an unseen companion",
        "A randomized trial of blood pressure treatment",
      ),
    ).toBe(false);
  });
});

class MemoryCache implements AbstractEnrichmentCache {
  entries: AbstractEnrichmentCacheEntry[] = [];

  async read(): Promise<AbstractEnrichmentCacheEntry[]> {
    return this.entries;
  }

  async write(entries: AbstractEnrichmentCacheEntry[]): Promise<void> {
    this.entries = entries;
  }
}

function source(): PaperSemanticSource {
  return {
    libraryID: 1,
    itemKey: "TEST1234",
    title: "Recurring stellar flares reveal an unseen companion",
    abstract: "",
    tags: ["stellar variability"],
    doi: "https://doi.org/10.1234/Example",
  };
}
