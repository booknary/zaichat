import { expect, it } from "vitest";
import { repairCitations } from "../src/agent/citationRepair";
import { ToolRegistry, requiresContextualQuestion } from "../src/agent/toolRegistry";

const source = {
  sourceID: "src-12345678-aaaa",
  item: { libraryID: 1, itemKey: "PAPER001" },
  label: "Paper",
  snippet: "We sampled 42 species.",
  field: "fulltext" as const,
};
it("expands only unique prefixes and rejects ambiguous IDs or item keys", () => {
  expect(repairCitations("[src-12345678]", [source.sourceID], [source])).toMatchObject({
    answer: `[${source.sourceID}]`,
    sourceIDs: [source.sourceID],
    invalid: [],
  });
  expect(
    repairCitations(
      "[src-12345678]",
      [],
      [source, { ...source, sourceID: "src-12345678-bbbb" }],
    ).invalid,
  ).toEqual(["src-12345678"]);
  expect(repairCitations("", ["PAPER001", "src-123"], [source]).invalid).toHaveLength(
    2,
  );
});
it("returns actionable errors and blocks title-only method answers", async () => {
  const registry = new ToolRegistry({} as any);
  (registry as any).sourceWhitelist.set(source.sourceID, source);
  const context: any = {
    userQuery: "怎么选择物种的？",
    evidenceBudget: { remainingChars: 60000 },
  };
  const finish = (answer: string, sourceIDs: string[]) =>
    registry.execute(
      {
        id: "f",
        name: "finish_answer",
        arguments: { answer, sourceIDs, evidenceInsufficient: false },
      },
      context,
    );
  expect(
    (await finish("We sampled species [src-12345678]", [source.sourceID])).ok,
  ).toBe(true);
  const invalid = await finish("Claim [src-forged]", []);
  expect(invalid.ok).toBe(false);
  expect((invalid.content as any).availableEvidence[0].sourceID).toBe(source.sourceID);
  (registry as any).sourceWhitelist.set("src-title", {
    ...source,
    sourceID: "src-title",
    snippet: undefined,
    field: "title",
  });
  expect(
    (await finish("共42个物种，偏好完整度较高的基因组。[src-title]", ["src-title"])).ok,
  ).toBe(false);
  context.userQuery = "是否有关于生态数据的文章？";
  expect((await finish("找到这篇文献 [src-title]", ["src-title"])).ok).toBe(true);
});

it("distinguishes methods questions from bibliographic existence questions", () => {
  expect(requiresContextualQuestion("这篇论文的数据来源是什么？")).toBe(true);
  expect(requiresContextualQuestion("Did they use flow cytometry?")).toBe(true);
  expect(requiresContextualQuestion("是否有关于基因组创新的文章？")).toBe(false);
  expect(
    requiresContextualQuestion("Find a paper titled A new method for sampling"),
  ).toBe(false);
});
