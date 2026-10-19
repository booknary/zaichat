import { describe, expect, it } from "vitest";
import { normalizeQuery, rankDocuments, recallTerms } from "../src/retrieval/ranking";

const base = {
  item: { libraryID: 1, itemKey: "A" },
  title: "Deep learning for proteins",
  abstract: "A transformer model for protein structure prediction",
  authors: ["Alice Smith"],
  tags: ["AlphaFold"],
  year: 2024,
  itemType: "journalArticle",
  language: "en",
  collections: ["COLL"],
  notes: ["important structural biology"],
  annotations: [],
  fulltext: ["attention mechanisms improve accuracy"],
};

describe("retrieval ranking", () => {
  it("recovers complete search phrases from token arrays returned by non-strict providers", () => {
    const query = normalizeQuery({
      englishQueries: ["two genomic innovations"],
      searchCombinations: [
        ["two", "genomic novelty"],
        ["two bursts", "genome innovation"],
        "independent complete phrase",
        ["two", "genomic novelty"],
      ],
      required: [["genomic novelty"]],
      optional: [],
      excluded: [],
    });

    expect(query.searchCombinations).toEqual([
      "two genomic novelty",
      "two bursts genome innovation",
      "independent complete phrase",
    ]);
  });

  it("normalizes terms and enforces hard filters", () => {
    const query = normalizeQuery({
      required: [["protein"]],
      optional: [["transformer"]],
      excluded: ["review"],
      yearMin: 2020,
      limit: 10,
    });
    const results = rankDocuments(
      [
        base,
        {
          ...base,
          item: { libraryID: 1, itemKey: "B" },
          title: "Review of protein models",
        },
      ],
      query,
    );
    expect(results).toHaveLength(1);
    expect(results[0].item.itemKey).toBe("A");
    expect(results[0].matchedFields).toContain("title");
  });

  it("gives title and multi-field matches a higher score", () => {
    const query = normalizeQuery({
      required: [],
      optional: [["protein"]],
      excluded: [],
      limit: 10,
    });
    const abstractOnly = {
      ...base,
      item: { libraryID: 1, itemKey: "B" },
      title: "Unrelated title",
      tags: [],
      notes: [],
      fulltext: [],
    };
    expect(rankDocuments([abstractOnly, base], query)[0].item.itemKey).toBe("A");
  });

  it("recalls synonyms fairly and ranks full concept coverage above partial matches", () => {
    const query = normalizeQuery({
      required: [
        ["alpha", "first synonym"],
        ["beta", "second synonym"],
        ["gamma", "third synonym"],
      ],
      optional: [],
      excluded: [],
    });
    expect(recallTerms(query)).toEqual(
      expect.arrayContaining([
        "alpha",
        "beta",
        "gamma",
        "first synonym",
        "second synonym",
        "third synonym",
      ]),
    );
    const complete = {
      ...base,
      item: { libraryID: 1, itemKey: "COMPLETE" },
      title: "Alpha beta gamma",
    };
    const partial = {
      ...base,
      item: { libraryID: 1, itemKey: "PARTIAL" },
      title: "Alpha beta",
    };
    expect(
      rankDocuments([partial, complete], query).map((item) => item.item.itemKey),
    ).toEqual(["COMPLETE", "PARTIAL"]);
  });

  it("ranks an exact supplied title above concept matches and recalls combinations", () => {
    const exactTitle = "A calibrated framework for coupled alpha and beta processes";
    const query = normalizeQuery({
      exactTitles: [exactTitle],
      englishQueries: ["calibrated alpha beta framework"],
      searchCombinations: ["coupled alpha process", "beta process framework"],
      required: [["unmatched model concept"]],
      optional: [],
      excluded: [],
    });
    const exact = {
      ...base,
      item: { libraryID: 1, itemKey: "EXACT" },
      title: exactTitle,
    };
    expect(rankDocuments([base, exact], query)[0].item.itemKey).toBe("EXACT");
    expect(recallTerms(query)).toEqual(
      expect.arrayContaining([
        "calibrated alpha beta framework",
        "coupled alpha process",
        "beta process framework",
      ]),
    );
    expect(recallTerms(query)).not.toContain(exactTitle.toLocaleLowerCase());
  });

  it("uses a structured remembered-item paraphrase without flattening it into tokens", () => {
    const targetTitle = "A dual transition shaped the alpha process";
    const query = normalizeQuery({
      discipline: "synthetic studies",
      subfield: "alpha systems",
      intent: "remembered_item",
      concepts: [
        {
          label: "event structure",
          meaning: "A remembered proposition involving two changes",
          role: "required",
          variants: [
            {
              term: "two changes",
              relation: "canonical",
              confidence: "high",
              origin: "model_inferred",
            },
            {
              term: "dual transition",
              relation: "rhetorical_paraphrase",
              confidence: "high",
              origin: "model_inferred",
            },
          ],
        },
        {
          label: "process",
          meaning: "The alpha process under study",
          role: "required",
          variants: [
            {
              term: "alpha process",
              relation: "canonical",
              confidence: "high",
              origin: "model_inferred",
            },
          ],
        },
      ],
      englishQueries: ["dual transition alpha process"],
      searchCombinations: [
        "two changes alpha process",
        "dual transition process",
        "alpha process transition",
      ],
      excluded: [],
      limit: 12,
    });
    const target = {
      ...base,
      item: { libraryID: 1, itemKey: "TARGET" },
      title: targetTitle,
      abstract: "A field-specific account of the alpha system.",
      tags: [],
      notes: [],
      fulltext: [],
    };
    const unrelated = {
      ...base,
      item: { libraryID: 1, itemKey: "UNRELATED" },
      title: "A practical workflow for alpha measurement",
      abstract: "Methods for routine calibration.",
      tags: [],
      notes: [],
      fulltext: [],
    };
    expect(recallTerms(query)).toContain("dual transition");
    expect(recallTerms(query)).not.toContain("dual");
    expect(rankDocuments([unrelated, target], query)[0].item.itemKey).toBe("TARGET");
  });

  it("keeps bounded planner routes beyond the first generated phrases", () => {
    const query = normalizeQuery({
      englishQueries: [
        "alpha beta relation one",
        "alpha beta relation two",
        "alpha beta relation three",
        "alpha beta relation four",
        "alpha beta relation five",
        "alpha beta relation six",
        "alpha beta relation seven",
        "alpha beta relation eight",
        "alpha beta relation nine",
      ],
      searchCombinations: [
        "alpha beta synthesis",
        "beta alpha framework",
        "coupled alpha beta",
      ],
      required: [["alpha"], ["beta"]],
      optional: [],
      excluded: [],
    });
    const routes = recallTerms(query);
    expect(routes).toContain("alpha beta relation nine");
    expect(routes).toContain("beta");
    expect(query.englishQueries?.every((term) => routes.includes(term))).toBe(true);
  });

  it("keeps a strong title and abstract match above an incidental full-text mention", () => {
    const query = normalizeQuery({
      englishQueries: ["plant whole genome alignment progressive cactus"],
      searchCombinations: [
        "plant genome alignment",
        "progressive cactus plants",
        "whole genome alignment cactus",
      ],
      required: [
        ["plant", "angiosperm"],
        ["whole genome alignment"],
        ["progressive cactus", "cactus"],
      ],
      optional: [],
      excluded: [],
      limit: 10,
    });
    const strongMetadata = {
      ...base,
      item: { libraryID: 1, itemKey: "STRONG" },
      title: "Plant comparative genomics with whole-genome alignment",
      abstract: "We apply Progressive Cactus across flowering plant genomes.",
      tags: [],
      notes: [],
      fulltext: [],
      provenance: ["metadata", "abstract"] as const,
    };
    const incidental = {
      ...base,
      item: { libraryID: 1, itemKey: "INCIDENTAL" },
      title: "A general review of plant evolution",
      abstract: "Plant plant plant diversity and classification.",
      tags: [],
      notes: [],
      fulltext: ["Progressive Cactus is mentioned in one reference."],
      provenance: ["metadata", "fulltext"] as const,
    };
    expect(rankDocuments([incidental, strongMetadata], query)[0].item.itemKey).toBe(
      "STRONG",
    );
  });

  it("strongly rewards coverage of independent required concept families", () => {
    const query = normalizeQuery({
      englishQueries: ["plant whole genome alignment progressive cactus"],
      searchCombinations: [
        "plant genome alignment",
        "progressive cactus plants",
        "whole genome alignment cactus",
      ],
      required: [
        ["plant", "angiosperm"],
        ["whole genome alignment"],
        ["progressive cactus", "cactus"],
      ],
      optional: [],
      excluded: [],
      limit: 10,
    });
    const complete = {
      ...base,
      item: { libraryID: 1, itemKey: "COMPLETE" },
      title: "Cross-species analysis",
      abstract: "Angiosperm genomes analyzed by whole genome alignment.",
      fulltext: ["Progressive Cactus"],
      tags: [],
      notes: [],
    };
    const repeatedBroadConcept = {
      ...base,
      item: { libraryID: 1, itemKey: "BROAD" },
      title: "Plant plant plant evolution",
      abstract: "Plant diversity across plant lineages and plant genomes.",
      fulltext: [],
      tags: ["plant"],
      notes: ["plant"],
    };
    expect(rankDocuments([repeatedBroadConcept, complete], query)[0].item.itemKey).toBe(
      "COMPLETE",
    );
  });
});
