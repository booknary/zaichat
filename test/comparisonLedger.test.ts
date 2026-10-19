import { expect, it } from "vitest";
import {
  ComparisonLedger,
  comparisonRequested,
  evidenceNumbers,
} from "../src/agent/comparisonLedger";
import { ToolRegistry } from "../src/agent/toolRegistry";
import { toolsForAgentState } from "../src/agent/agentState";

const source = (id: string, n: number) => ({
  sourceID: id,
  item: { libraryID: 1, itemKey: id },
  label: `Paper ${id}`,
  field: "abstract",
  snippet: `We sampled ${n} species in the experiment.`,
});
const a = source("src-a", 84),
  b = source("src-b", 350);
const sources = new Map([
  [a.sourceID, a],
  [b.sourceID, b],
]);

it("accepts space-separated thousands and groups by basis, not paper descriptions", () => {
  expect(evidenceNumbers("332 341; 339\u202f876; 32\u00a0129; 33,623")).toEqual([
    332341, 339876, 32129, 33623,
  ]);
  expect(evidenceNumbers("18 genera, 3 species")).toEqual([18, 3]);
  const ledger = new ComparisonLedger();
  const values = ledger.record(
    [
      { ...row(), scope: "Population A", measurementBasis: "compiled" },
      { ...row(b, 350), scope: "Population B", measurementBasis: "compiled" },
    ],
    sources,
    false,
  );
  expect(values.map((r) => r.value)).toEqual([350, 84]);
  expect(ledger.markdown().match(/#### /g)).toHaveLength(1);
});
const row = (s = a, value = 84) => ({
  sourceID: s.sourceID,
  quote: s.snippet,
  metric: "sample size",
  value,
  unit: "species",
  scope: "measured",
});

it("sorts source-backed numbers within groups and keeps prior rows", () => {
  const ledger = new ComparisonLedger();
  ledger.record([row()], sources, false);
  expect(ledger.record([row(b, 350)], sources, false).map((r) => r.value)).toEqual([
    350, 84,
  ]);
  expect(ledger.markdown()).toContain("[src-b]");
  expect(ledger.record([row()], sources, true).map((r) => r.value)).toEqual([84, 350]);
  ledger.record([{ ...row(), scope: "modeled" }], sources, false);
  expect(ledger.snapshot()).toHaveLength(3);
  ledger.clear();
  expect(ledger.snapshot()).toEqual([]);
});

it("rejects forged quotes, values, unknown sources and oversized records atomically", () => {
  const ledger = new ComparisonLedger();
  for (const invalid of [
    { ...row(), value: 85 },
    { ...row(), quote: "Invented evidence with 84 species." },
    { ...row(), sourceID: "src-unknown" },
    { ...row(), quote: "" },
    { ...row(), metric: "x".repeat(151) },
  ]) {
    expect(() => ledger.record([row(b, 350), invalid], sources, false)).toThrow();
    expect(ledger.snapshot()).toHaveLength(0);
  }
  expect(() => ledger.record([], sources, false)).toThrow();
});

it("appends deterministic rankings with current citations and resets between runs", async () => {
  const registry = new ToolRegistry({ resetEvidenceSession() {} } as any);
  (registry as any).sourceWhitelist = new Map(sources);
  const context: any = {
    userQuery: "按样本量降序排序",
    context: { refs: { items: [], attachments: [] } },
    evidenceBudget: { remainingChars: 60000 },
  };
  const record = await registry.execute(
    {
      id: "r",
      name: "record_comparison",
      arguments: { rows: [row(), row(b, 350)], ascending: false },
    },
    context,
  );
  expect(record.ok).toBe(true);
  expect(context.evidenceBudget.remainingChars).toBe(60000);
  const finish = await registry.execute(
    {
      id: "f",
      name: "finish_answer",
      arguments: {
        answer: "部分已核实结果如下。",
        sourceIDs: [],
        evidenceInsufficient: true,
      },
    },
    context,
  );
  expect(finish.ok).toBe(true);
  expect(finish.sources?.map((s) => s.sourceID)).toEqual(["src-b", "src-a"]);
  expect((finish.content as any).answer.indexOf("350")).toBeLessThan(
    (finish.content as any).answer.indexOf("84"),
  );
  expect(registry.comparisonEvidence()).toContain("350");
  registry.clearSources();
  expect(registry.comparisonEvidence()).toBe("");
});

it("does not add a comparison tool to ordinary identification", () => {
  const defs = [{ function: { name: "record_comparison" } }];
  expect(comparisonRequested("帮我找一篇文章")).toBe(false);
  expect(toolsForAgentState(defs, "evidence-ready", "帮我找一篇文章")).toEqual([]);
  expect(toolsForAgentState(defs, "evidence-ready", "按数量排序")).toEqual(defs);
});

it("reuses unchanged delivered abstracts without spending evidence budget again", () => {
  const registry = new ToolRegistry({} as any);
  const budget = { remainingChars: 60000 };
  const record = { item: a.item, title: a.label, abstract: a.snippet };
  const read = () =>
    (registry as any).directResult(
      { id: "a", name: "read_abstracts" },
      [record],
      budget,
      true,
    );
  const first = read();
  const remaining = budget.remainingChars;
  expect(read().sources[0].sourceID).toBe(first.sources[0].sourceID);
  expect(budget.remainingChars).toBe(remaining);
  record.abstract += " Updated finding.";
  expect(read().sources[0].sourceID).not.toBe(first.sources[0].sourceID);
  expect(budget.remainingChars).toBeLessThan(remaining);
});
