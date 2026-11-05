import { expect, it } from "vitest";
import { coverageClaimProblems } from "../src/agent/coverageClaims";
import { ToolRegistry } from "../src/agent/toolRegistry";

it.each([
  "这是本库里唯一使用该分析的工作。末尾说明：只检查了部分候选。",
  "## 唯一一篇\n目前只看了部分结果。",
  "本库只有一篇相关论文。",
  "This is the only paper in your library. Only part of the pool was checked.",
  "There are no other matching papers in the library.",
])("rejects unscoped exclusivity even after pool exhaustion: %s", (answer) => {
  expect(coverageClaimProblems(answer, 0).length).toBeGreaterThan(0);
});
it.each([
  "在本轮已核验的候选中，目前只有一篇明确符合条件。",
  "Among the checked candidates, only one paper is confirmed.",
  "无法确认它是否是本库唯一符合条件的研究。",
  "不能断言库中没有其他相关文章。",
  "The checked results do not prove this is the only paper in the library.",
  "本轮未找到明确匹配项。",
  "该研究给每个样本分配唯一标识符。",
  "在本轮从文库返回的候选中，目前只有一篇明确符合条件。",
  "Only one paper among the checked candidates is confirmed.",
  "本轮搜索文库，没有修改任何标签。",
])("accepts bounded findings and ordinary unique identifiers: %s", (answer) => {
  expect(coverageClaimProblems(answer, 9)).toEqual([]);
});
it("keeps the scoped partial answer repairable with no extra reading", async () => {
  const registry = new ToolRegistry({} as any);
  (registry as any).activePlan = { intent: "topic" };
  (registry as any).poolKeys = new Set(["1:EXAMPLE1"]);
  const source = {
    sourceID: "src-example-paper",
    item: { libraryID: 1, itemKey: "EXAMPLE1" },
    label: "Example",
    field: "title",
  };
  (registry as any).sourceWhitelist.set(source.sourceID, source);
  const ctx: any = {
    evidenceBudget: { remainingChars: 0 },
    userQuery: "Find relevant papers",
  };
  const finish = (args: any) =>
    registry.execute({ id: "f", name: "finish_answer", arguments: args }, ctx);
  const base = { sourceIDs: [source.sourceID], evidenceInsufficient: false };
  const rejected = await finish({
    ...base,
    answer: "本库只有一篇相关论文 [src-example-paper]。",
  });
  expect(rejected.ok).toBe(false);
  expect((rejected.content as any).draftRetained).toBe(true);
  const repaired = await finish({
    ...base,
    repair: {
      answerPatches: [
        {
          original: "本库只有一篇相关论文",
          replacement: "在本轮已检查的候选中，确认一篇相关论文",
        },
      ],
    },
  });
  expect(repaired.ok).toBe(true);
  const coverage = registry.coverageSummary();
  expect(coverage.abstractsWithDeliveredText).toBe(0);
  expect(coverage.papersWithDeliveredFulltext).toBe(0);
});
