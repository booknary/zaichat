import { describe, expect, it } from "vitest";
import { RetrievalQuery } from "../src/core/types";
import {
  diverseHypothesisCount,
  rememberedItemPlanIssues,
} from "../src/retrieval/rememberedItemPlan";

describe("remembered item plan", () => {
  it("accepts discipline-independent, materially different title hypotheses", () => {
    const query = plan([
      "repeated stellar brightening reveals a hidden companion",
      "a concealed companion behind recurring increases in stellar luminosity",
      "episodic stellar flares expose an unseen binary partner",
      "multiple stellar outbursts disclose a faint companion star",
    ]);
    expect(rememberedItemPlanIssues(query)).toEqual([]);
  });

  it("rejects a set made from reordered copies", () => {
    const hypotheses = [
      "hidden companion causes repeated stellar brightening",
      "repeated stellar brightening caused by hidden companion",
      "stellar brightening repeatedly caused by a hidden companion",
      "a hidden companion causes stellar brightening repeatedly",
    ];
    expect(diverseHypothesisCount(hypotheses)).toBeLessThan(3);
    expect(rememberedItemPlanIssues(plan(hypotheses)).join(" ")).toContain(
      "materially different",
    );
  });

  it("does not impose the remembered-item protocol on topical searches", () => {
    expect(
      rememberedItemPlanIssues({
        ...plan([]),
        intent: "topic",
      }),
    ).toEqual([]);
  });

  it("rejects diverse hypotheses that omit a required concept", () => {
    const query = plan([
      "repeated stellar brightening reveals a hidden companion",
      "a concealed companion behind recurring increases in stellar luminosity",
      "episodic stellar flares expose an unseen binary partner",
      "multiple stellar outbursts disclose a faint companion star",
    ]);
    query.concepts?.push({
      label: "spectroscopic confirmation",
      meaning: "the remembered item explicitly used spectroscopy",
      role: "required",
      variants: [
        {
          term: "spectroscopic confirmation",
          relation: "canonical",
          confidence: "high",
          origin: "model_inferred",
        },
      ],
    });
    expect(rememberedItemPlanIssues(query).join(" ")).toContain(
      "spectroscopic confirmation",
    );
  });
});

function plan(titleHypotheses: string[]): RetrievalQuery {
  return {
    discipline: "astronomy",
    subfield: "stellar variability",
    intent: "remembered_item",
    concepts: [
      {
        label: "brightness event",
        meaning: "a remembered change in stellar brightness",
        role: "required",
        variants: [
          {
            term: "stellar brightening",
            relation: "canonical",
            confidence: "high",
            origin: "model_inferred",
          },
          {
            term: "stellar luminosity",
            relation: "established_term",
            confidence: "high",
            origin: "model_inferred",
          },
          {
            term: "stellar flares",
            relation: "rhetorical_paraphrase",
            confidence: "medium",
            origin: "model_inferred",
          },
          {
            term: "stellar outbursts",
            relation: "rhetorical_paraphrase",
            confidence: "medium",
            origin: "model_inferred",
          },
        ],
      },
    ],
    exactTitles: [],
    titleHypotheses,
    englishQueries: ["stellar brightening"],
    searchCombinations: [
      "stellar brightening companion",
      "recurring luminosity binary",
      "episodic flare companion star",
    ],
    required: [["stellar brightening"]],
    optional: [],
    excluded: [],
    limit: 12,
  };
}
