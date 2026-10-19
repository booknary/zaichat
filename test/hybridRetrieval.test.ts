import { describe, expect, it } from "vitest";
import { RetrievedItem, RetrievalQuery } from "../src/core/types";
import { normalizeText } from "../src/retrieval/ranking";
import {
  fuseHybridResults,
  fuseSemanticRouteResults,
  semanticQueryTexts,
  literalUserTerms,
  fulltextDiscoveryTerms,
} from "../src/host/zoteroRetriever";

describe("hybrid retrieval", () => {
  it.each(["QuasiFlux", "spectral quenching", "TopoGraph-v2"])(
    "preserves user term %s even when the planner replaces it",
    (term) => {
      const user = `哪篇文章提到 ${term}？`;
      const query = plan();
      // Existing retrieval normalization folds case and punctuation, not spelling.
      expect(literalUserTerms(user)).toEqual([normalizeText(term)]);
      expect(semanticQueryTexts(query, user)).toContain(normalizeText(term));
      expect(fulltextDiscoveryTerms(query, 24, user)[0]).toBe(normalizeText(term));
      expect(fulltextDiscoveryTerms(query, 24, user).length).toBeLessThanOrEqual(24);
    },
  );
  it("preserves quoted terms without guessing corrections or parsing English sentences", () => {
    expect(literalUserTerms('Find "RareMethod" papers')).toEqual(["raremethod"]);
    expect(literalUserTerms("Find an article about adaptive change")).toEqual([]);
  });

  it("embeds bounded semantic routes separately instead of one diluted prompt", () => {
    const query = plan();
    const routes = semanticQueryTexts(query, "帮我找那篇恒星突然变亮的文章");
    expect(routes.length).toBeGreaterThan(6);
    expect(routes.length).toBeLessThanOrEqual(32);
    expect(routes).toContain("帮我找那篇恒星突然变亮的文章");
    expect(routes.some((route) => query.titleHypotheses?.includes(route))).toBe(true);
    expect(routes).toContain("stellar brightening hidden companion");
    expect(routes).toContain("recurring stellar luminosity companion");
    expect(routes).toContain("repeated increases in a star's observed brightness");
    expect(routes).not.toContain("weak expansion");
    expect(routes.every((route) => route.length <= 600)).toBe(true);
  });

  it("searches every bounded title interpretation for a remembered item", () => {
    const query = plan();
    query.titleHypotheses = Array.from(
      { length: 8 },
      (_, index) =>
        `independent remembered stellar brightening interpretation ${index + 1}`,
    );

    const routes = semanticQueryTexts(query, "模糊记得某篇文章");

    expect(
      query.titleHypotheses.every((hypothesis) => routes.includes(hypothesis)),
    ).toBe(true);
  });

  it("reserves route-family coverage so hypotheses cannot starve other semantic evidence", () => {
    const query = plan();
    query.titleHypotheses = Array.from(
      { length: 8 },
      (_, index) => `title hypothesis route ${index + 1}`,
    );
    query.englishQueries = ["english scholarly reformulation"];
    query.searchCombinations = ["cross concept search phrase"];

    const routes = semanticQueryTexts(query, "original multilingual request", 6);

    expect(routes).toContain("original multilingual request");
    expect(routes.some((route) => route.startsWith("title hypothesis route"))).toBe(
      true,
    );
    expect(routes).toContain("english scholarly reformulation");
    expect(routes).toContain("cross concept search phrase");
    expect(routes).toContain("repeated increases in a star's observed brightness");
    expect(routes).toContain("stellar brightening");
  });

  it("selects a later high-information combination over early paraphrase duplicates", () => {
    const query = plan();
    query.titleHypotheses = [
      "dual stellar innovation",
      "two stellar innovations",
      "two innovations in stars",
      "two bursts of stellar novelty reveal companion evolution",
    ];
    query.englishQueries = [
      "two stellar innovations",
      "dual stellar innovation",
      "stellar novelty in two events",
    ];
    query.searchCombinations = [
      "two stellar innovation",
      "dual innovation star",
      "stellar novelty two events",
      "two bursts stellar novelty hidden companion",
    ];

    const routes = semanticQueryTexts(query, "两次恒星创新", 12);
    expect(routes).toContain("stellar novelty in two events");
    expect(routes).toContain("two bursts stellar novelty hidden companion");
    expect(new Set(routes.map((route) => route.toLocaleLowerCase())).size).toBe(
      routes.length,
    );
  });

  it("builds generic cross-concept synonym routes instead of trusting model combinations alone", () => {
    const query = plan();
    query.concepts = [
      {
        label: "repetition",
        meaning: "an event happened twice",
        role: "required",
        variants: [
          { term: "twice", relation: "exact_synonym", confidence: "high" },
          { term: "two rounds", relation: "established_term", confidence: "high" },
          {
            term: "two waves",
            relation: "rhetorical_paraphrase",
            confidence: "medium",
          },
        ],
      },
      {
        label: "innovation",
        meaning: "novel change at a system level",
        role: "required",
        variants: [
          { term: "system innovation", relation: "canonical", confidence: "high" },
          {
            term: "system novelty",
            relation: "exact_synonym",
            confidence: "medium",
          },
        ],
      },
    ];
    query.searchCombinations = [
      "two system innovations",
      "two rounds system innovation",
      "system innovation twice",
    ];

    const routes = semanticQueryTexts(query, "两次系统创新", 14);

    expect(routes).toContain("twice system novelty");
    expect(routes).toContain("two waves system novelty");
  });

  it("keeps a low-confidence remembered-item sense available to semantic recall", () => {
    const query = plan();
    query.concepts = [
      {
        label: "event count",
        meaning: "the remembered phenomenon occurred twice",
        role: "required",
        variants: [{ term: "twice", relation: "canonical", confidence: "high" }],
      },
      {
        label: "event property",
        meaning: "a novel or newly emerging property",
        role: "required",
        variants: [
          { term: "innovation", relation: "canonical", confidence: "high" },
          { term: "novelty", relation: "lexical_variant", confidence: "low" },
        ],
      },
    ];

    const routes = semanticQueryTexts(query, "two remembered events", 14);

    expect(routes).toContain("twice novelty");
  });

  it("keeps a merely related mechanism out of anchored remembered-item routes", () => {
    const query = plan();
    query.titleHypotheses = [
      "three episodes of stellar fading reveal a companion",
      "repeated stellar dimming exposes an unseen partner",
      "multiple stellar fading events identify a hidden binary",
      "three cycles of reduced stellar brightness disclose a companion",
    ];
    query.englishQueries = ["three stellar fading events"];
    query.searchCombinations = [
      "three stellar fading events",
      "three stellar supernova events",
      "repeated stellar dimming companion",
    ];
    query.concepts = [
      {
        label: "event count",
        meaning: "the phenomenon occurred three times",
        role: "required",
        variants: [
          { term: "three", relation: "canonical", confidence: "high" },
          { term: "three episodes", relation: "lexical_variant", confidence: "high" },
        ],
      },
      {
        label: "stellar fading",
        meaning: "a star became less bright",
        role: "required",
        variants: [
          { term: "stellar fading", relation: "canonical", confidence: "high" },
          { term: "stellar dimming", relation: "exact_synonym", confidence: "high" },
          { term: "supernova", relation: "related_term", confidence: "low" },
        ],
      },
    ];

    const routes = semanticQueryTexts(query, "有篇文章说恒星三次变暗");

    expect(routes).toContain("three stellar dimming");
    expect(routes.some((route) => /supernova/i.test(route))).toBe(false);
  });

  it.each([
    {
      label: "history",
      first: ["three", "three cycles"],
      second: ["archive", "archival records"],
      third: ["migration", "relocation"],
      related: "war",
    },
    {
      label: "medicine",
      first: ["dual", "two episodes"],
      second: ["immune response", "inflammation"],
      third: ["remission", "resolution"],
      related: "antibiotic",
    },
    {
      label: "engineering",
      first: ["repeated", "multiple cycles"],
      second: ["thermal system", "heat network"],
      third: ["failure", "breakdown"],
      related: "coolant",
    },
  ])(
    "builds bounded full-concept contrastive routes without $label vocabulary rules",
    ({ first, second, third, related }) => {
      const query = contrastivePlan(first, second, third, related);

      const routes = semanticQueryTexts(query, "ambiguous remembered item");

      expect(
        routes.some(
          (route) =>
            route.includes(first[1]) &&
            second.some((term) => route.includes(term)) &&
            route.includes(third[1]),
        ),
      ).toBe(true);
      expect(routes.every((route) => !route.includes(related))).toBe(true);
      expect(routes.length).toBeLessThanOrEqual(32);
    },
  );

  it("fuses independent semantic routes without duplicating the same item", () => {
    const routes = [
      [semanticHit("COMMON", 0.9, ["title"]), semanticHit("FIRST", 0.8)],
      [semanticHit("COMMON", 0.85, ["abstract"]), semanticHit("SECOND", 0.82)],
    ];

    const fused = fuseSemanticRouteResults(routes, 3);

    expect(fused.map((entry) => entry.itemKey)).toEqual(["COMMON", "SECOND", "FIRST"]);
    expect(fused[0].sourceFields).toEqual(["title", "abstract"]);
  });

  it("does not discard a precise top-ten hit behind broad multi-route votes", () => {
    const broadRoutes = Array.from({ length: 8 }, (_, routeIndex) => [
      semanticHit(`NOISE${routeIndex}`, 0.91),
      semanticHit("PRECISE", 0.9),
      semanticHit("BROAD", 0.82),
    ]);
    broadRoutes.push([
      semanticHit("TARGET", 0.96),
      semanticHit("OTHER", 0.9),
      semanticHit("PRECISE", 0.88),
      semanticHit("BROAD", 0.87),
    ]);

    const fused = fuseSemanticRouteResults(broadRoutes, 4);

    expect(fused.map((entry) => entry.itemKey)).toContain("TARGET");
    expect(fused.map((entry) => entry.itemKey)).toContain("PRECISE");
  });

  it("preserves an item ranked sixth by several independent interpretations", () => {
    const routes = Array.from({ length: 9 }, (_, routeIndex) =>
      Array.from({ length: 12 }, (_, rankIndex) =>
        semanticHit(
          rankIndex === 5 && routeIndex < 3
            ? "INDEPENDENT"
            : `NOISE-${routeIndex}-${rankIndex}`,
          0.95 - rankIndex * 0.01,
        ),
      ),
    );

    const fused = fuseSemanticRouteResults(routes, 15);

    expect(fused.map((entry) => entry.itemKey)).toContain("INDEPENDENT");
  });

  it.each([11, 18, 30])(
    "retains repeated rank-%i evidence over isolated top-ten hits",
    (rank) => {
      const routes = Array.from({ length: 4 }, (_, route) =>
        Array.from({ length: 30 }, (_, index) =>
          semanticHit(
            index === rank - 1 ? "CONSENSUS" : `UNIQUE-${route}-${index}`,
            0.95 - index * 0.005,
          ),
        ),
      );
      expect(fuseSemanticRouteResults(routes, 1)[0].itemKey).toBe("CONSENSUS");
    },
  );

  it("counts a paper only once per route and does not mutate inputs", () => {
    const routes = [
      [semanticHit("REPEATED", 0.9), semanticHit("REPEATED", 0.9)],
      [semanticHit("OTHER", 0.95)],
      [],
    ];
    const original = JSON.stringify(routes);
    const result = fuseSemanticRouteResults(routes, 5);
    expect(result.map((hit) => hit.itemKey)).toEqual(["OTHER", "REPEATED"]);
    expect(JSON.stringify(routes)).toBe(original);
  });

  it("uses reciprocal-rank fusion and retains semantic-only candidates", () => {
    const common = item("COMMON", "Common candidate", ["metadata"]);
    const commonSemantic = item("COMMON", "Common candidate", ["semantic"]);
    const lexicalOnly = item("LEXICAL", "Lexical candidate", ["metadata"]);
    const semanticOnly = item("SEMANTIC", "Semantic candidate", ["semantic"]);
    const fused = fuseHybridResults(
      [lexicalOnly, common],
      [semanticOnly, commonSemantic],
      3,
    );
    expect(fused.map((entry) => entry.item.itemKey)).toEqual([
      "COMMON",
      "SEMANTIC",
      "LEXICAL",
    ]);
    expect(fused[0].provenance).toEqual(["metadata", "semantic"]);
    expect(fused[1].provenance).toContain("semantic");
  });

  it("keeps a bounded semantic reserve when lexical candidates dominate", () => {
    const lexical = Array.from({ length: 24 }, (_, index) =>
      item(`LEX${index}`, `Lexical ${index}`, ["metadata"]),
    );
    const semantic = Array.from({ length: 14 }, (_, index) =>
      item(`SEM${index}`, `Semantic ${index}`, ["semantic"]),
    );

    const fused = fuseHybridResults(lexical, semantic, 18);

    expect(fused).toHaveLength(18);
    expect(fused.map((entry) => entry.item.itemKey)).toContain("SEM9");
  });
});

function plan(): RetrievalQuery {
  return {
    intent: "remembered_item",
    exactTitles: [],
    titleHypotheses: [
      "repeated stellar brightening reveals a hidden companion",
      "a concealed companion behind recurring increases in stellar luminosity",
      "episodic flares expose an unseen binary partner",
      "multiple outbursts disclose a faint companion star",
    ],
    englishQueries: ["stellar brightening hidden companion"],
    searchCombinations: ["recurring stellar luminosity companion"],
    concepts: [
      {
        label: "stellar brightening",
        meaning: "repeated increases in a star's observed brightness",
        role: "required",
        variants: [
          {
            term: "stellar brightening",
            relation: "exact_synonym",
            confidence: "high",
          },
          {
            term: "stellar luminosity",
            relation: "established_term",
            confidence: "high",
          },
          {
            term: "stellar flares",
            relation: "rhetorical_paraphrase",
            confidence: "medium",
          },
          {
            term: "stellar outbursts",
            relation: "rhetorical_paraphrase",
            confidence: "medium",
          },
          {
            term: "weak expansion",
            relation: "related_term",
            confidence: "low",
          },
        ],
      },
    ],
    required: [["stellar brightening"]],
    optional: [],
    excluded: [],
    limit: 10,
  };
}

function contrastivePlan(
  first: string[],
  second: string[],
  third: string[],
  related: string,
): RetrievalQuery {
  const concept = (label: string, terms: string[], weakRelated?: string) => ({
    label,
    meaning: `Meaning of ${label}`,
    role: "required" as const,
    variants: [
      { term: terms[0], relation: "canonical" as const, confidence: "high" as const },
      {
        term: terms[1],
        relation: "exact_synonym" as const,
        confidence: "high" as const,
      },
      ...(weakRelated
        ? [
            {
              term: weakRelated,
              relation: "related_term" as const,
              confidence: "low" as const,
            },
          ]
        : []),
    ],
  });
  return {
    intent: "remembered_item",
    concepts: [
      concept("structure", first),
      concept("subject", second),
      concept("change", third, related),
    ],
    exactTitles: [],
    titleHypotheses: [],
    englishQueries: [],
    searchCombinations: [],
    required: [first, second, third],
    optional: [],
    excluded: [],
    limit: 18,
  };
}

function semanticHit(
  itemKey: string,
  score: number,
  sourceFields: Array<"title" | "abstract" | "tags"> = ["title"],
) {
  return { libraryID: 1, itemKey, score, sourceFields };
}

function item(
  itemKey: string,
  title: string,
  provenance: RetrievedItem["provenance"],
): RetrievedItem {
  return {
    item: { libraryID: 1, itemKey },
    title,
    abstract: "",
    authors: [],
    tags: [],
    attachmentRefs: [],
    provenance,
    score: 0.8,
    matchedFields: ["title"],
  };
}
