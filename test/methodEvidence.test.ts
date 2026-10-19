import { expect, it } from "vitest";
import type { SourceReference } from "../src/core/types";
import {
  classifyPassage,
  indexCompleteness,
} from "../src/retrieval/evidenceProvenance";
import {
  categoricalSupplementAbsence,
  methodEvidenceIssue,
  methodQuestion,
} from "../src/agent/methodEvidence";
import { ToolRegistry } from "../src/agent/toolRegistry";

const source = (
  section: "methods" | "references" | "unknown",
  key = "PAPER001",
): SourceReference => ({
  sourceID: `src-${section}-${key}`,
  item: { libraryID: 1, itemKey: key },
  label: "Synthetic analysis",
  field: "fulltext",
  snippet:
    section === "references"
      ? "1. Carter, A. Software Toolkit version 5. Methods Journal (2021)."
      : "We used Software Toolkit version 5 with 100 replicates to infer the tree.",
  provenance: {
    section,
    basis: section === "unknown" ? "unknown" : "heading",
    confidence: section === "unknown" ? "low" : "high",
  },
});
const fact = (s: SourceReference) => ({
  sourceID: s.sourceID,
  quote: s.snippet!,
  fact: "The authors used Toolkit v5 with 100 replicates.",
  kind: "method" as const,
});

it("labels explicit references, renewed methods headings and unknown prose conservatively", () => {
  const text =
    "Methods\nWe used Toolkit.\nReferences\n1. Carter, A. Toolkit manual.\nSupplementary methods\nData\nMethods\nWe sampled sites.";
  const at = text.indexOf("1. Carter");
  expect(classifyPassage(text, at, at + 29)).toMatchObject({
    section: "references",
    confidence: "high",
  });
  const methods = text.indexOf("We sampled");
  expect(classifyPassage(text, methods, text.length).section).toBe("methods");
  expect(classifyPassage("Toolkit version 5 is available.", 0, 30).section).toBe(
    "unknown",
  );
  expect(
    classifyPassage("1. Carter, A. Toolkit. 2. Jones, B. toolkit.", 0, 50).section,
  ).toBe("references");
  expect(classifyPassage("Fig. 2: Replicate trees.", 0, 22).section).toBe(
    "figure-legend",
  );
});
it("maps Zotero index states without claiming model reading completeness", () => {
  expect(indexCompleteness("3")).toBe("indexed");
  expect(indexCompleteness("2")).toBe("partial");
  expect(indexCompleteness("1")).toBe("not-fully-indexed");
  expect(indexCompleteness("unknown")).toBe("unknown");
});
it("requires genuine per-paper method quotes and accepts unknown sections without certifying them", () => {
  const s = source("methods"),
    other = source("unknown", "PAPER002");
  const check = (facts: any[]) =>
    methodEvidenceIssue(
      "How did they conduct the analysis?",
      "They used Toolkit.",
      [s, other],
      facts,
      false,
    );
  expect(check([])).toContain("each cited paper");
  expect(check([fact(s)])).toContain("each cited paper");
  expect(check([fact(s), fact(other)])).toBeUndefined();
  expect(
    check([
      { ...fact(s), quote: "We used a different invented workflow." },
      fact(other),
    ]),
  ).toContain("verbatim");
});
it("never treats bibliography software/version mentions as execution evidence", () => {
  const s = source("references");
  expect(
    methodEvidenceIssue(
      "具体方法流程是什么？",
      "使用了Toolkit 5",
      [s],
      [fact(s)],
      false,
    ),
  ).toContain("reference-list");
  expect(
    methodEvidenceIssue(
      "具体方法流程是什么？",
      "引用列表提及Toolkit，实际方法尚无法确认",
      [s],
      [{ ...fact(s), kind: "mention" }],
      true,
    ),
  ).toBeUndefined();
  expect(
    methodEvidenceIssue(
      "具体方法流程是什么？",
      `本文使用Toolkit [${s.sourceID}]`,
      [s],
      [],
      true,
    ),
  ).toContain("cannot bypass");
});
it("limits absence to checked passages rather than repairing it with a closing caveat", () => {
  const s = source("methods");
  expect(
    methodEvidenceIssue(
      "How was the workflow performed?",
      "The paper did not perform reconstruction. Only some evidence was read.",
      [s],
      [],
      true,
    ),
  ).toContain("Bounded cache");
  expect(
    methodEvidenceIssue(
      "分析方法是什么？",
      "这篇论文没有进行重建。结尾提醒：只读了部分片段。",
      [s],
      [],
      true,
    ),
  ).toContain("Bounded cache");
  expect(
    methodEvidenceIssue(
      "分析方法是什么？",
      "目前已核查片段未找到明确说明，无法确认是否进行了重建。",
      [s],
      [],
      true,
    ),
  ).toBeUndefined();
  const absent = {
    ...s,
    snippet: "We did not perform ancestral reconstruction in this analysis.",
  };
  expect(
    methodEvidenceIssue(
      "How was the workflow performed?",
      `The paper did not perform reconstruction [${absent.sourceID}].`,
      [absent],
      [
        {
          ...fact(absent),
          fact: "The paper did not perform reconstruction",
          kind: "explicit-absence",
        },
      ],
      false,
    ),
  ).toBeUndefined();
  expect(
    methodEvidenceIssue(
      "How was the workflow performed?",
      "The other paper did not perform reconstruction.",
      [absent],
      [
        {
          ...fact(absent),
          fact: "The paper did not perform reconstruction",
          kind: "explicit-absence",
        },
      ],
      true,
    ),
  ).toContain("Bounded cache");
});

it("checks actual method-use intent without imposing a PDF audit on title search", () => {
  const s = source("methods");
  expect(
    methodEvidenceIssue(
      "Find papers that use this tool",
      "The authors used Toolkit",
      [s],
      [],
      false,
      true,
    ),
  ).toContain("each cited paper");
  expect(
    methodEvidenceIssue(
      "Find a paper titled Toolkit",
      "A matching title",
      [s],
      [],
      false,
    ),
  ).toBeUndefined();
});
it("does not turn identification or abstract translation into a method audit", () => {
  expect(methodQuestion("Find a paper titled A new method for sampling")).toBe(false);
  expect(methodQuestion("找一篇介绍系统树方法的文章")).toBe(false);
  expect(methodQuestion("翻译这个摘要")).toBe(false);
  expect(
    methodEvidenceIssue(
      "翻译这个摘要",
      "The paper did not perform a test.",
      [],
      [],
      false,
    ),
  ).toBeUndefined();
  expect(categoricalSupplementAbsence("库中没有单独补充材料 PDF。")).toBe(true);
  expect(
    categoricalSupplementAbsence("未找到明确标注补充材料的文件，两个PDF角色尚不确定。"),
  ).toBe(false);
});
it("returns already available direct evidence on a rejected method answer", async () => {
  const registry = new ToolRegistry({} as any),
    s = source("methods"),
    bib = source("references");
  for (const row of [s, bib]) (registry as any).sourceWhitelist.set(row.sourceID, row);
  const context: any = {
    userQuery: "具体分析方法是什么？",
    evidenceBudget: { remainingChars: 60000 },
  };
  const finish = (args: any) =>
    registry.execute({ id: "f", name: "finish_answer", arguments: args }, context);
  const rejected = await finish({
    answer: `本文使用Toolkit [${bib.sourceID}]`,
    sourceIDs: [bib.sourceID],
    evidenceInsufficient: false,
  });
  expect(rejected.ok).toBe(false);
  expect((rejected.content as any).availableEvidence[0].sourceID).toBe(s.sourceID);
  expect(
    (
      await finish({
        answer: `本文使用Toolkit [${s.sourceID}]`,
        sourceIDs: [s.sourceID],
        evidenceInsufficient: false,
        evidenceFacts: [fact(s)],
      })
    ).ok,
  ).toBe(true);
});
