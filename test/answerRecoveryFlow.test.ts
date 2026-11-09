import { expect, it } from "vitest";
import { ToolRegistry } from "../src/agent/toolRegistry";
import { methodScopeProblems } from "../src/agent/methodScope";
import { conversationEvidence } from "../src/agent/conversationEvidence";
import { classifyPassage } from "../src/retrieval/evidenceProvenance";
import type { SourceReference, StoredMessage } from "../src/core/types";

const paper = {
  libraryID: 1,
  itemKey: "SYNTH001",
  title: "Synthetic functional analysis",
};
const source: SourceReference = {
  sourceID: "src-synthetic-current",
  item: paper,
  label: paper.title,
  field: "fulltext",
  snippet: "We applied Toolkit to summarize the enriched categories.",
  provenance: { section: "methods", basis: "heading", confidence: "high" },
};
const fact = {
  sourceID: source.sourceID,
  quote: source.snippet!,
  fact: "Toolkit summarized categories.",
  kind: "method",
};
const context: any = {
  userQuery: "这篇论文用了什么分析方法？",
  context: { refs: { items: [], attachments: [] } },
  evidenceBudget: { remainingChars: 60000 },
  maxAttachments: 8,
};
const input = {
  answer: `Toolkit summarized categories. [${source.sourceID}]`,
  sourceIDs: [source.sourceID],
  evidenceFacts: [fact],
  evidenceInsufficient: false,
};

it("returns an executable missing inventory action and revalidates the retained draft", async () => {
  const registry = new ToolRegistry({
    listAttachments: async () => ({
      items: [],
      totalAvailable: 0,
      offset: 0,
      nextOffset: null,
    }),
  } as any);
  (registry as any).sourceWhitelist.set(source.sourceID, source);
  const rejected = await registry.execute(
    { id: "a", name: "finish_answer", arguments: input },
    context,
  );
  expect(rejected.ok).toBe(false);
  const action = (rejected.content as any).recovery.requiredActions[0];
  expect(action).toEqual({ tool: "list_attachments", arguments: { ref: paper } });
  const read = await registry.execute(
    { id: "b", name: action.tool, arguments: action.arguments },
    context,
  );
  expect(read.ok).toBe(true);
  const retried = await registry.execute(
    {
      id: "c",
      name: "finish_answer",
      arguments: { sourceIDs: input.sourceIDs, evidenceInsufficient: false },
    },
    context,
  );
  expect(retried.ok).toBe(true);
  expect((retried.content as any).answer).toBe(input.answer);
});

it("distinguishes absent passages from editable quote mismatches and does not silently drop facts", async () => {
  const registry = new ToolRegistry({} as any);
  (registry as any).sourceWhitelist.set(source.sourceID, {
    ...source,
    snippet: undefined,
    field: "title",
  });
  const run = (args: any) =>
    registry.execute({ id: "f", name: "finish_answer", arguments: args }, context);
  const rejected = await run(input);
  expect((rejected.content as any).issues[0].code).toBe("missing-passage");
  expect((rejected.content as any).recovery.requiredActions).toContainEqual({
    tool: "verify_candidates",
    arguments: { sourceIDs: [source.sourceID] },
  });
  const retried = await run({ sourceIDs: input.sourceIDs, evidenceInsufficient: true });
  expect((retried.content as any).issues[0].code).toBe("missing-passage");
  (registry as any).sourceWhitelist.set(source.sourceID, source);
  expect(
    (await run({ sourceIDs: input.sourceIDs, evidenceInsufficient: false })).ok,
  ).toBe(true);
});

it("candidate fallback discards unsupported prose and rejects unknown source IDs", async () => {
  const registry = new ToolRegistry({
    listAttachments: async () => {
      throw Error("should not read");
    },
  } as any);
  (registry as any).sourceWhitelist.set(source.sourceID, {
    ...source,
    field: "title",
    snippet: undefined,
  });
  const run = (args: any) =>
    registry.execute({ id: "f", name: "finish_answer", arguments: args }, context);
  const accepted = await run({
    ...input,
    answer: "The study definitely used an invented method.",
    candidateOnly: true,
  });
  expect(accepted.ok).toBe(true);
  expect((accepted.content as any).answer).toContain("待核实候选");
  expect((accepted.content as any).answer).not.toContain("invented");
  expect((accepted.content as any).answer).toContain(source.sourceID);
  expect((await run({ candidateOnly: true, sourceIDs: ["src-not-current"] })).ok).toBe(
    false,
  );
});

it.each([
  "该方法只用于图件排序。结尾说明：补充材料尚未核对。",
  "语义聚类纯属可读性处理。",
  "方法在正文，不在SI里。",
  "没有把基因按相似度聚成功能模块。",
  "The method was only used for plotting.",
])("requires local scope for exclusive-purpose claims: %s", (answer) => {
  expect(methodScopeProblems(answer, [source], [])).toHaveLength(1);
});

it.each([
  "已读图注只说明了展示排序用途，其他分析用途尚未确认。",
  "I only read the abstract.",
  "不能确认它只用于图件排序。",
  "The checked passages describe only the plotting use.",
])("preserves scoped findings and reading disclosures: %s", (answer) => {
  expect(methodScopeProblems(answer, [source], [])).toEqual([]);
});

it("ends caption provenance at an unrecognized subheading and on long-distance carryover", () => {
  const quote = "We fitted a model to the measured observations.";
  const text =
    "Figure 4 | Summary of observations.\nMeasurements are plotted.\nStatistical modelling of observations\n" +
    quote;
  expect(classifyPassage(text, text.indexOf(quote), text.length)).toMatchObject({
    section: "unknown",
    confidence: "low",
  });
  const long = "Figure 4 | Summary.\n" + "Ordinary prose. ".repeat(160) + quote;
  expect(classifyPassage(long, long.indexOf(quote), long.length).section).toBe(
    "unknown",
  );
  const methods = text + "\nMethods\n" + quote;
  expect(
    classifyPassage(methods, methods.lastIndexOf(quote), methods.length).section,
  ).toBe("methods");
});

function history(): StoredMessage[] {
  return [
    {
      id: "old",
      role: "assistant",
      displayText: "Previous supported response",
      createdAt: "2026-01-01T00:00:00Z",
      sourceRefs: [source],
      agentEvents: [
        {
          id: "trace",
          type: "diagnostic",
          summary: "Tool execution recorded",
          createdAt: "2026-01-01T00:00:00Z",
          details: {
            tool: "plan_search",
            retrievalTrace: [
              {
                ...paper,
                lexicalRank: 2,
                fusedRank: 18,
                stage: "pending-page",
                delivered: false,
              },
            ],
          },
        },
        {
          id: "page",
          type: "diagnostic",
          summary: "Tool execution recorded",
          createdAt: "2026-01-01T00:00:01Z",
          details: {
            tool: "next_search_results",
            retrievalTrace: [{ ...paper, stage: "selected", delivered: true }],
          },
        },
      ],
    },
  ];
}

it("preserves recorded recall and delivery without inventing verification or user clues", () => {
  const record = JSON.parse(conversationEvidence(history(), "为什么之前没找到呢"));
  expect(record.retrievalHistory[0].searches[0].candidates[0]).toMatchObject({
    lexicalRank: 2,
    fusedRank: 18,
    delivered: false,
  });
  expect(record.retrievalHistory[0].searches[1].candidates[0].delivered).toBe(true);
  expect(record.instruction).toContain("not that it read or verified");
  const missing = history();
  missing[0].agentEvents = [];
  expect(
    JSON.parse(conversationEvidence(missing, "为什么之前没找到呢")).retrievalHistory[0]
      .searches,
  ).toEqual([]);
});

it("carries prior excerpts as dated historical context without reviving old citation IDs", () => {
  const record = conversationEvidence(history(), "这篇文章的方法是什么？");
  expect(record).toContain(source.snippet);
  expect(record).not.toContain(source.sourceID);
  expect(JSON.parse(record).priorPassages[0].readAt).toBe("2026-01-01T00:00:00Z");
  expect(conversationEvidence(history(), "Find papers about another topic")).toBe("");
});

it("allows bibliographic citations beside current passage evidence from the same paper", async () => {
  const registry = new ToolRegistry({} as any);
  const title = {
    ...source,
    sourceID: "src-synthetic-title",
    field: "title",
    snippet: undefined,
  };
  (registry as any).sourceWhitelist.set(source.sourceID, source);
  (registry as any).sourceWhitelist.set(title.sourceID, title);
  (registry as any).directRefs.set("1:SYNTH001", paper);
  const answer = input.answer + " Paper title [" + title.sourceID + "].";
  const accepted = await registry.execute(
    {
      id: "f",
      name: "finish_answer",
      arguments: { ...input, answer, sourceIDs: [source.sourceID, title.sourceID] },
    },
    context,
  );
  expect(accepted.ok).toBe(true);
  const rejected = await registry.execute(
    {
      id: "f",
      name: "finish_answer",
      arguments: {
        answer: "The study used Toolkit [" + title.sourceID + "]",
        sourceIDs: [title.sourceID],
        evidenceInsufficient: false,
      },
    },
    context,
  );
  expect(rejected.ok).toBe(false);
  expect((rejected.content as any).recovery.requiredActions[0].tool).toBe(
    "read_abstracts",
  );
});
