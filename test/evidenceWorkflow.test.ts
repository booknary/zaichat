import { expect, it } from "vitest";
import { authorEvidence } from "../src/agent/authorEvidence";
import { ToolRegistry } from "../src/agent/toolRegistry";
import { selectAnswerSources } from "../src/agent/agentRunner";
import { toolsForAgentState, transitionAfterTool } from "../src/agent/agentState";

const source = (id: string, key = id) => ({
  sourceID: id,
  item: { libraryID: 1, itemKey: key },
  label: "Synthetic",
  field: "abstract",
  snippet: "Treatment A increased growth; treatment B did not increase growth.",
});
function fixture() {
  const registry = new ToolRegistry({} as any);
  const a = source("src-a"),
    b = source("src-b");
  (registry as any).sourceWhitelist.set(a.sourceID, a);
  (registry as any).sourceWhitelist.set(b.sourceID, b);
  const context: any = {
    conversationID: "test",
    userQuery: "Identify a paper",
    maxAttachments: 20,
    context: { refs: { items: [], attachments: [] } },
    evidenceBudget: { remainingChars: 60000 },
  };
  const finish = (args: any) =>
    registry.execute({ id: "f", name: "finish_answer", arguments: args }, context);
  return { registry, a, b, context, finish };
}
it("matches late-position authors without transmitting the entire author field", () => {
  const names = Array.from({ length: 700 }, (_, i) => `Other Person ${i}`);
  names[660] = "María Q. Example";
  const result = authorEvidence(names, "Maria Q Example");
  expect(result.authorMatches).toEqual([{ name: names[660], position: 661 }]);
  expect(result.authorCount).toBe(700);
  expect(result.authors).toHaveLength(1);
  expect(authorEvidence(names, "Different Example").authorMatches).toEqual([]);
});
it("permits a supported positive answer with incomplete candidate enumeration", async () => {
  const { registry, finish } = fixture();
  (registry as any).remainingCandidates = [
    { item: { libraryID: 1, itemKey: "OTHER" } },
  ];
  const answer = await finish({
    answer: "A matching paper exists [src-a]; other candidates remain unreviewed.",
    sourceIDs: ["src-a"],
    evidenceInsufficient: true,
  });
  expect(answer.ok).toBe(true);
});
it("retains more than eight inline citations and rejects unknown inline IDs", async () => {
  const { registry, finish } = fixture();
  const sources = Array.from({ length: 14 }, (_, i) => source(`src-e${i}`));
  sources.forEach((s) => (registry as any).sourceWhitelist.set(s.sourceID, s));
  const answer = sources.map((s) => `(${s.sourceID})`).join(" ");
  const result = await finish({
    answer,
    sourceIDs: [sources[0].sourceID],
    evidenceInsufficient: false,
  });
  expect(result.ok).toBe(true);
  expect(result.sources).toHaveLength(14);
  expect((result.content as any).answer).toContain("[src-e13]");
  expect(selectAnswerSources(answer, result.sources!)).toHaveLength(14);
  expect(
    (
      await finish({
        answer: "[src-forged]",
        sourceIDs: [],
        evidenceInsufficient: false,
      })
    ).ok,
  ).toBe(false);
});
it("preserves multiple explicitly cited evidence IDs for the same paper", () => {
  expect(
    selectAnswerSources("[src-a] [src-b]", [
      source("src-a", "SAME"),
      source("src-b", "SAME"),
    ] as any),
  ).toHaveLength(2);
});
it("requires real evidence quotes for multi-abstract comparisons", async () => {
  const { context, finish, a, b } = fixture();
  context.userQuery = "比较这两篇摘要";
  const args = {
    answer: "The studies reported treatment effects [src-a] [src-b].",
    sourceIDs: ["src-a", "src-b"],
    evidenceInsufficient: false,
  };
  expect((await finish(args)).ok).toBe(false);
  const facts = [a, b].map((s) => ({
    sourceID: s.sourceID,
    quote: s.snippet,
    fact: "Treatment A increased growth; B did not.",
  }));
  expect((await finish({ ...args, evidenceFacts: facts })).ok).toBe(true);
  facts[1].quote = "An invented finding not in the abstract.";
  expect((await finish({ ...args, evidenceFacts: facts })).ok).toBe(false);
});
it("does not let fresh collection titles stand in for old abstract findings", async () => {
  const { registry, finish } = fixture();
  const title = { ...source("src-title"), field: "title", snippet: undefined };
  (registry as any).sourceWhitelist.set(title.sourceID, title);
  (registry as any).directRefs.set(`1:${title.item.itemKey}`, title.item);
  expect(
    (
      await finish({
        answer: "The authors reported improved growth [src-title].",
        sourceIDs: ["src-title"],
        evidenceInsufficient: false,
      })
    ).ok,
  ).toBe(false);
});
it("offers abstract reading after search without trapping the run in direct-reading", () => {
  const { registry } = fixture();
  expect(
    toolsForAgentState(
      registry.definitions(),
      "search-results-ready",
      "find paper",
    ).map((d) => d.function.name),
  ).toContain("read_abstracts");
  expect(
    transitionAfterTool("search-results-ready", {
      ok: true,
      name: "read_abstracts",
    } as any),
  ).toBe("evidence-ready");
  expect(
    transitionAfterTool("direct-reading", { ok: true, name: "read_abstracts" } as any),
  ).toBe("direct-reading");
});
