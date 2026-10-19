import { afterEach, expect, it, vi } from "vitest";
import { causalClaimProblems } from "../src/agent/answerClaims";
import { repairAnswerDraft } from "../src/agent/answerRepair";
import { evidenceFactProblems, methodEvidenceIssue } from "../src/agent/methodEvidence";
import { ToolRegistry } from "../src/agent/toolRegistry";
import type { SourceReference } from "../src/core/types";

afterEach(() => vi.unstubAllGlobals());
const source: SourceReference = {
  sourceID: "src-current-analysis",
  item: { libraryID: 1, itemKey: "PAPER001" },
  label: "Synthetic analysis",
  field: "fulltext",
  snippet: "We used Toolkit with 20 replicates. Trait A was associated with trait B.",
  provenance: { section: "methods", basis: "heading", confidence: "high" },
};
const fact = {
  sourceID: source.sourceID,
  quote: "We used Toolkit with 20 replicates.",
  fact: "Toolkit was used with 20 replicates.",
  kind: "method" as const,
};

it("reports all invalid fact indexes without weakening exact quote checks", () => {
  const problems = evidenceFactProblems(
    [source],
    [
      { ...fact, quote: "We used **Toolkit** with 20 replicates." },
      { ...fact, quote: "We used another program with 40 replicates." },
      fact,
    ],
  );
  expect(problems.map((problem) => problem.factIndex)).toEqual([0, 1]);
  expect(problems.every((problem) => problem.code === "quote-mismatch")).toBe(true);
  expect(evidenceFactProblems([source], [null] as any)).toMatchObject([
    { factIndex: 0, code: "invalid-evidence-fact" },
  ]);
});

it("rejects categorical method absence without a repeated paper subject", () => {
  const query = "这个分析具体怎么进行？";
  expect(
    methodEvidenceIssue(
      query,
      "性状历史是标注与计数，不是自己重建节点状态。结尾：只读了片段。",
      [source],
      [fact],
      true,
    ),
  ).toContain("Bounded cache");
  expect(
    methodEvidenceIssue(
      query,
      "没有任何软件被表述为用于该重建。",
      [source],
      [fact],
      true,
    ),
  ).toContain("Bounded cache");
  expect(
    methodEvidenceIssue(
      query,
      "当前片段支持标注与计数，尚无法确认作者是否另外重建节点状态。",
      [source],
      [fact],
      true,
    ),
  ).toBeUndefined();
});

it("does not upgrade an association to a causal arrow or let a closing caveat repair it", () => {
  expect(
    causalClaimProblems(
      `因果方向恰好是反过来的（A作为原因，B作为结果）[${source.sourceID}]。最后提醒：只是关联。`,
      [source],
    ),
  ).toHaveLength(1);
  expect(
    causalClaimProblems(`这证明A导致B [${source.sourceID}]`, [source]),
  ).toHaveLength(1);
  expect(
    causalClaimProblems(`不能证明A导致B；研究检验A与B的关联 [${source.sourceID}]`, [
      source,
    ]),
  ).toEqual([]);
  expect(
    causalClaimProblems(`作者假设A是原因，还需要实验研究设计 [${source.sourceID}]`, [
      source,
    ]),
  ).toEqual([]);
});

it("uses the claim's own cited evidence rather than another paper's causal wording", () => {
  const direct = {
    ...source,
    sourceID: "src-direct-causal",
    snippet: "Our randomized experiment provides causal evidence for the effect.",
  };
  expect(
    causalClaimProblems(`This proves causal effects [${direct.sourceID}].`, [
      source,
      direct,
    ]),
  ).toEqual([]);
  expect(
    causalClaimProblems(`This proves causal effects [${source.sourceID}].`, [
      source,
      direct,
    ]),
  ).toHaveLength(1);
  expect(
    causalClaimProblems(`This proves causal effects [${source.sourceID}].`, [
      {
        ...source,
        snippet: "An association was observed, but no causal evidence was established.",
      },
    ]),
  ).toHaveLength(1);
});

it("patches only unique literal spans and keeps the draft immutable", () => {
  const draft = {
    answer: "First claim. Second claim.",
    sourceIDs: [source.sourceID],
    evidenceInsufficient: false,
    evidenceFacts: [fact],
  };
  const input = {
    sourceIDs: draft.sourceIDs,
    evidenceInsufficient: false,
    repair: {
      answerPatches: [
        { original: "Second claim.", replacement: "Qualified second claim." },
      ],
    },
  };
  expect(repairAnswerDraft(draft, input).answer).toBe(
    "First claim. Qualified second claim.",
  );
  expect(draft.answer).toBe("First claim. Second claim.");
  expect(repairAnswerDraft(draft, input).evidenceFacts).toEqual([fact]);
  expect(() => repairAnswerDraft(undefined, input)).toThrow("No rejected");
  expect(() => repairAnswerDraft(draft, { ...input, answer: "A new answer" })).toThrow(
    "not both",
  );
  expect(() =>
    repairAnswerDraft({ ...draft, answer: "Second claim. Second claim." }, input),
  ).toThrow("exactly one");
  expect(() =>
    repairAnswerDraft(draft, {
      ...input,
      repair: { answerPatches: [{ original: "missing", replacement: "new" }] },
    }),
  ).toThrow("exactly one");
  expect(() =>
    repairAnswerDraft(draft, {
      ...input,
      repair: { answerPatches: [{ original: "First claim.", replacement: 7 }] },
    }),
  ).toThrow("strings");
});

it("repairs facts without resending the answer and validates repaired claims again", async () => {
  const registry = new ToolRegistry({} as any);
  (registry as any).sourceWhitelist.set(source.sourceID, source);
  const context: any = {
    userQuery: "具体分析方法是什么？",
    evidenceBudget: { remainingChars: 60000 },
  };
  const finish = (args: any) =>
    registry.execute({ id: "finish", name: "finish_answer", arguments: args }, context);
  const base = {
    answer: `The authors used Toolkit [${source.sourceID}].`,
    sourceIDs: [source.sourceID],
    evidenceInsufficient: false,
  };
  const rejected = await finish({
    ...base,
    evidenceFacts: [{ ...fact, quote: "We used a made-up method with 50 replicates." }],
  });
  expect(rejected.ok).toBe(false);
  expect((rejected.content as any).issues[0]).toMatchObject({
    factIndex: 0,
    sourceID: source.sourceID,
  });
  expect((rejected.content as any).draftRetained).toBe(true);
  expect(
    (
      await finish({
        sourceIDs: base.sourceIDs,
        evidenceInsufficient: false,
        repair: {},
        evidenceFacts: [fact],
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await finish({
        sourceIDs: base.sourceIDs,
        evidenceInsufficient: false,
        repair: {},
        evidenceFacts: [fact],
      })
    ).ok,
  ).toBe(false);
  const claim = `这证明A导致B [${source.sourceID}]`;
  expect((await finish({ ...base, answer: claim, evidenceFacts: [fact] })).ok).toBe(
    false,
  );
  const stillBad = await finish({
    sourceIDs: base.sourceIDs,
    evidenceInsufficient: false,
    repair: { answerPatches: [{ original: "这证明A导致B", replacement: "A作为原因" }] },
  });
  expect(stillBad.ok).toBe(false);
  const accepted = await finish({
    sourceIDs: base.sourceIDs,
    evidenceInsufficient: false,
    repair: {
      answerPatches: [
        {
          original: "A作为原因",
          replacement: "已核查证据只报告A与B关联，因果尚无法确认",
        },
      ],
    },
  });
  expect(accepted.ok).toBe(true);
});

it("discards repair state on turn reset", async () => {
  const registry = new ToolRegistry({} as any);
  const context: any = {
    userQuery: "分析方法？",
    evidenceBudget: { remainingChars: 60000 },
  };
  await registry.execute(
    {
      id: "bad",
      name: "finish_answer",
      arguments: {
        answer: "Unsupported answer",
        sourceIDs: [],
        evidenceInsufficient: false,
      },
    },
    context,
  );
  registry.beginTurn("new-chat", "new-user", undefined, false);
  const repaired = await registry.execute(
    {
      id: "patch",
      name: "finish_answer",
      arguments: {
        sourceIDs: [],
        evidenceInsufficient: true,
        repair: {
          answerPatches: [{ original: "Unsupported", replacement: "Unverified" }],
        },
      },
    },
    context,
  );
  expect(repaired.ok).toBe(false);
  expect((repaired.content as any).error).toContain("No rejected");
});

it("patches the reported claim after automatic citation-prefix normalization", async () => {
  const registry = new ToolRegistry({} as any);
  (registry as any).sourceWhitelist.set(source.sourceID, source);
  const context: any = {
    userQuery: "What association was found?",
    evidenceBudget: { remainingChars: 60000 },
  };
  const finish = (args: any) =>
    registry.execute({ id: "f", name: "finish_answer", arguments: args }, context);
  const rejected = await finish({
    answer: "这证明A导致B src-current-analys",
    sourceIDs: ["src-current-analys"],
    evidenceInsufficient: false,
  });
  expect(rejected.ok).toBe(false);
  const original = (rejected.content as any).issues[0].claim;
  expect(original).toContain(`[${source.sourceID}]`);
  const accepted = await finish({
    repair: {
      answerPatches: [
        { original, replacement: `证据报告A与B的关联 [${source.sourceID}]` },
      ],
    },
    sourceIDs: [source.sourceID],
    evidenceInsufficient: false,
  });
  expect(accepted.ok).toBe(true);
});

it("does not confuse a missing method in a resolved paper with a missing library paper", async () => {
  const registry = new ToolRegistry({} as any);
  (registry as any).sourceWhitelist.set(source.sourceID, source);
  (registry as any).fulltextDeferred = true;
  (registry as any).exactTitlesResolved = true;
  const context: any = {
    userQuery: "这篇论文的方法是什么？",
    evidenceBudget: { remainingChars: 60000 },
  };
  const finish = (answer: string) =>
    registry.execute(
      {
        id: "f",
        name: "finish_answer",
        arguments: { answer, sourceIDs: [source.sourceID], evidenceInsufficient: true },
      },
      context,
    );
  expect(
    (await finish(`已核查片段未找到明确方法说明，无法确认 [${source.sourceID}]`)).ok,
  ).toBe(true);
  expect((await finish(`库中没有任何类似研究 [${source.sourceID}]`)).ok).toBe(false);
});
