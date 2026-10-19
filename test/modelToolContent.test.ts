import { expect, it } from "vitest";
import { modelToolContent } from "../src/agent/modelToolContent";
import type { ToolResult } from "../src/core/types";
import { retrievalStrategyPrompt } from "../src/agent/retrievalStrategyPrompt";

it("keeps consolidated retrieval guidance within a tight existing context budget", () => {
  expect(retrievalStrategyPrompt("").length).toBeLessThan(19500);
});

it("omits repeated debug/route dumps but preserves candidates, constraints, IDs and coverage", () => {
  const content = {
    plan: {
      id: "plan-1",
      intent: "remembered_item",
      concepts: [
        {
          label: "Adaptive trait",
          meaning: "A repeated origin",
          role: "required",
          variants: Array(80).fill({
            term: "hypothetical terminology route",
            confidence: "low",
          }),
        },
      ],
      required: [["adaptive trait"]],
      excluded: ["explicit exclusion"],
      exactTitles: ["User supplied title"],
      yearMin: 2020,
      englishQueries: Array(10).fill("long hypothetical query".repeat(12)),
    },
    executedRecallTerms: Array(30).fill("route ".repeat(15)),
    terminologyDiagnostics: { routes: Array(40).fill("diagnostic ".repeat(20)) },
    discovery: {
      exactTitleResolved: true,
      scope: "supplied-exact-titles",
      fulltextDeferred: true,
      semanticCandidates: 40,
      semanticRoutes: Array(12).fill("local embedding route ".repeat(15)),
      semanticFailedRoutes: 1,
      degradedFields: { abstract: 1 },
      timingsMs: { metadataRecall: 100 },
    },
    items: [
      {
        sourceID: "src-a",
        item: { libraryID: 1, itemKey: "PAPER001" },
        title: "Adaptive trait",
        abstractExcerpt: "Relevant evidence",
      },
    ],
    coverage: { fulltextDeferred: true, remainingCandidates: 5 },
    totalAvailable: 6,
  };
  const result: ToolResult = {
    toolCallID: "p",
    name: "plan_search",
    ok: true,
    summary: "Found",
    content,
  };
  const wire = modelToolContent(result) as any;
  expect(wire.items).toBe(content.items);
  expect(wire.coverage).toBe(content.coverage);
  expect(wire.plan.required).toEqual(content.plan.required);
  expect(wire.plan.filters.yearMin).toBe(2020);
  expect(wire.plan.exactTitles).toEqual(content.plan.exactTitles);
  expect(wire.discovery.semanticFailedRoutes).toBe(1);
  expect(wire.discovery.scope).toBe("supplied-exact-titles");
  expect(wire.discovery.exactTitleResolved).toBe(true);
  expect(wire.terminologyDiagnostics).toBeUndefined();
  expect(JSON.stringify(wire).length).toBeLessThan(
    JSON.stringify(content).length * 0.25,
  );
  expect(content.plan.concepts[0].variants).toHaveLength(80);
  expect(modelToolContent({ ...result, ok: false })).toBe(content);
  expect(modelToolContent({ ...result, name: "read_abstracts" })).toBe(content);
});
