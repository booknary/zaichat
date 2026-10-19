import {
  classifyPassage,
  indexCompleteness,
} from "../src/retrieval/evidenceProvenance";
import { scanTermHits } from "../src/retrieval/passageReader";
import { ToolRegistry } from "../src/agent/toolRegistry";
import type { SourceReference } from "../src/core/types";

describe("Bounded method evidence in Zotero", function () {
  it("recognizes sections and capped literal hits in the host runtime", function () {
    const text =
      "Methods\nWe used Toolkit with 20 replicates.\nReferences\n1. Carter, A. Toolkit handbook.";
    const pos = text.indexOf("1. Carter");
    if (
      classifyPassage(text, pos, text.length).section !== "references" ||
      indexCompleteness("3") !== "indexed" ||
      indexCompleteness("2") !== "partial" ||
      scanTermHits("toolkit ".repeat(2100), ["toolkit"])[0].countCapped !== true
    )
      throw new Error("Host provenance/count/state classification failed");
  });

  it("rejects reference-only execution and accepts an existing direct quote without another read", async function () {
    const registry = new ToolRegistry({} as any);
    const direct: SourceReference = {
      sourceID: "src-host-direct",
      item: { libraryID: 1, itemKey: "TEST0001" },
      label: "Synthetic workflow",
      field: "fulltext",
      snippet: "We used Toolkit with 20 replicates.",
      provenance: { section: "methods", basis: "heading", confidence: "high" },
    };
    const bib: SourceReference = {
      ...direct,
      sourceID: "src-host-bibliography",
      snippet: "1. Carter, A. Toolkit handbook, Methods Journal (2022).",
      provenance: { section: "references", basis: "heading", confidence: "high" },
    };
    for (const source of [direct, bib])
      (registry as any).sourceWhitelist.set(source.sourceID, source);
    const context: any = {
      userQuery: "What methods and workflow were used?",
      evidenceBudget: { remainingChars: 60000 },
    };
    const rejected = await registry.execute(
      {
        id: "bad",
        name: "finish_answer",
        arguments: {
          answer: `The authors used Toolkit [${bib.sourceID}]`,
          sourceIDs: [bib.sourceID],
          evidenceInsufficient: false,
        },
      },
      context,
    );
    if (
      rejected.ok ||
      !(rejected.content as any).availableEvidence.some(
        (row: any) => row.sourceID === direct.sourceID,
      )
    )
      throw new Error(
        "Reference-only execution was accepted or existing evidence was lost",
      );
    const accepted = await registry.execute(
      {
        id: "good",
        name: "finish_answer",
        arguments: {
          answer: `The authors used Toolkit with 20 replicates [${direct.sourceID}]`,
          sourceIDs: [direct.sourceID],
          evidenceInsufficient: false,
          evidenceFacts: [
            {
              sourceID: direct.sourceID,
              quote: direct.snippet,
              fact: "Toolkit was used with 20 replicates.",
              kind: "method",
            },
          ],
        },
      },
      context,
    );
    if (!accepted.ok)
      throw new Error(`Direct quoted evidence rejected: ${accepted.summary}`);
  });

  it("repairs a rejected fact locally without regenerating the answer", async function () {
    const registry = new ToolRegistry({} as any);
    const direct: SourceReference = {
      sourceID: "src-host-patch",
      item: { libraryID: 1, itemKey: "TEST0001" },
      label: "Synthetic patch test",
      field: "fulltext",
      snippet: "We used Toolkit with 20 replicates.",
      provenance: { section: "methods", basis: "heading", confidence: "high" },
    };
    (registry as any).sourceWhitelist.set(direct.sourceID, direct);
    const context: any = {
      userQuery: "What methods were used?",
      evidenceBudget: { remainingChars: 60000 },
    };
    const args = {
      answer: `The authors used Toolkit [${direct.sourceID}]`,
      sourceIDs: [direct.sourceID],
      evidenceInsufficient: false,
    };
    const bad = await registry.execute(
      {
        id: "bad",
        name: "finish_answer",
        arguments: {
          ...args,
          evidenceFacts: [
            {
              sourceID: direct.sourceID,
              quote: "We used an invented program with 30 trials.",
              fact: "An invented method was used.",
            },
          ],
        },
      },
      context,
    );
    const repaired = await registry.execute(
      {
        id: "repair",
        name: "finish_answer",
        arguments: {
          sourceIDs: args.sourceIDs,
          evidenceInsufficient: false,
          repair: {},
          evidenceFacts: [
            {
              sourceID: direct.sourceID,
              quote: direct.snippet,
              fact: "Toolkit was used with 20 replicates.",
              kind: "method",
            },
          ],
        },
      },
      context,
    );
    if (bad.ok || !repaired.ok || (repaired.content as any).answer !== args.answer)
      throw new Error("Host local fact repair failed or altered the retained answer");
  });
});
