import { describe, expect, it } from "vitest";
import { RetrievalConcept, RetrievalQuery } from "../src/core/types";
import { conceptCoverage, normalizeQuery } from "../src/retrieval/ranking";
import {
  normalizeTerminologyConcepts,
  selectRecallRoutes,
} from "../src/retrieval/terminology";

describe("structured terminology retrieval", () => {
  it("A: selects a high-confidence exact synonym before a weak related term", () => {
    const query = structuredQuery([
      concept("alpha concept", [
        variant("alpha canonical", "canonical", "high"),
        variant("alpha equivalent", "exact_synonym", "high"),
        variant("adjacent subject", "related_term", "low"),
      ]),
    ]);
    const routes = selectRecallRoutes(query, 8);
    expect(routes.selected.map((route) => route.term)).toContain("alpha equivalent");
    expect(routes.selected.map((route) => route.term)).not.toContain(
      "adjacent subject",
    );
    expect(routes.fallback.map((route) => route.term)).toContain("adjacent subject");
  });

  it("B: gives related terminology less concept credit than an exact synonym", () => {
    const concepts = [
      concept("alpha concept", [
        variant("alpha equivalent", "exact_synonym", "high"),
        variant("adjacent subject", "related_term", "low"),
      ]),
    ];
    expect(conceptCoverage("alpha equivalent", concepts)).toBeGreaterThan(
      conceptCoverage("adjacent subject", concepts),
    );
  });

  it("C: admits remembered-item paraphrases but keeps weak broader terms as fallback", () => {
    const query = structuredQuery(
      [
        concept("remembered proposition", [
          variant("remembered wording", "canonical", "high"),
          variant("scholarly reformulation", "rhetorical_paraphrase", "high"),
          variant("general area", "broader_term", "low"),
        ]),
      ],
      "remembered_item",
    );
    const routes = selectRecallRoutes(query, 8);
    expect(routes.selected.map((route) => route.term)).toContain(
      "scholarly reformulation",
    );
    expect(routes.fallback.map((route) => route.term)).toContain("general area");
  });

  it("D: preserves independent concepts under a tight route budget", () => {
    const query = structuredQuery([
      concept("alpha concept", [
        variant("alpha canonical", "canonical", "high"),
        variant("alpha exact", "exact_synonym", "high"),
        variant("alpha alternate", "established_term", "high"),
      ]),
      concept("beta concept", [
        variant("beta canonical", "canonical", "high"),
        variant("beta exact", "exact_synonym", "high"),
      ]),
    ]);
    const selected = selectRecallRoutes(query, 2).selected;
    expect(
      selected.some((route) => route.conceptLabels.includes("alpha concept")),
    ).toBe(true);
    expect(selected.some((route) => route.conceptLabels.includes("beta concept"))).toBe(
      true,
    );
  });

  it("E: lets a candidate-observed established term create a new revision route", () => {
    const initial = structuredQuery([
      concept("alpha concept", [variant("alpha canonical", "canonical", "high")]),
    ]);
    const revised = {
      ...initial,
      revisionReason: "Candidate language revealed a more specific field term",
      concepts: [
        concept("alpha concept", [
          variant("alpha canonical", "canonical", "high"),
          {
            ...variant("observed field term", "established_term", "high"),
            origin: "candidate_observed" as const,
          },
        ]),
      ],
    } as RetrievalQuery & { revisionReason: string };
    expect(
      selectRecallRoutes(initial, 8).selected.map((route) => route.term),
    ).not.toContain("observed field term");
    expect(
      selectRecallRoutes(revised, 8).selected.map((route) => route.term),
    ).toContain("observed field term");
  });

  it("F: remains bounded when the planner supplies excessive concepts and variants", () => {
    const rawConcepts = Array.from({ length: 20 }, (_, conceptIndex) =>
      concept(
        `concept ${conceptIndex}`,
        Array.from({ length: 20 }, (_, variantIndex) =>
          variant(
            `term ${conceptIndex} ${variantIndex}`,
            variantIndex ? "lexical_variant" : "canonical",
            "high",
          ),
        ),
      ),
    );
    const normalized = normalizeQuery({
      discipline: "synthetic discipline",
      intent: "topic",
      concepts: rawConcepts,
      excluded: [],
    });
    expect(normalized.concepts).toHaveLength(12);
    expect(normalized.concepts?.every((entry) => entry.variants.length <= 12)).toBe(
      true,
    );
    expect(selectRecallRoutes(normalized, 10).selected).toHaveLength(10);
  });

  it("G: converts legacy synonym groups into a safe structured plan", () => {
    const concepts = normalizeTerminologyConcepts(
      undefined,
      [["legacy canonical", "legacy alternative"]],
      [["legacy optional"]],
    );
    expect(concepts).toHaveLength(2);
    expect(concepts[0]).toMatchObject({
      role: "required",
      variants: [
        { relation: "canonical", confidence: "high" },
        { relation: "established_term", confidence: "medium" },
      ],
    });
    expect(concepts[1].role).toBe("optional");
  });
});

function structuredQuery(
  concepts: RetrievalConcept[],
  intent: RetrievalQuery["intent"] = "topic",
): RetrievalQuery {
  return normalizeQuery({
    discipline: "synthetic discipline",
    subfield: "controlled examples",
    intent,
    concepts,
    englishQueries: [],
    searchCombinations: [],
    excluded: [],
  });
}

function concept(
  label: string,
  variants: RetrievalConcept["variants"],
): RetrievalConcept {
  return {
    label,
    meaning: `Meaning of ${label}`,
    role: "required",
    variants,
  };
}

function variant(
  term: string,
  relation: RetrievalConcept["variants"][number]["relation"],
  confidence: RetrievalConcept["variants"][number]["confidence"],
): RetrievalConcept["variants"][number] {
  return { term, relation, confidence, origin: "model_inferred" };
}
