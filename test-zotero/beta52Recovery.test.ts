import { ToolRegistry } from "../src/agent/toolRegistry";
import { classifyPassage } from "../src/retrieval/evidenceProvenance";
import { methodScopeProblems } from "../src/agent/methodScope";

describe("Beta 52 answer recovery", function () {
  it("lists a missing inventory and resumes the retained answer in Zotero", async function () {
    const paper = { libraryID: 1, itemKey: "HOST0052" };
    const source = {
      sourceID: "src-host52-calibration",
      item: paper,
      label: "Synthetic calibration",
      field: "fulltext",
      snippet: "We calibrated the sensor with a thermal reference.",
      provenance: { section: "methods", basis: "heading", confidence: "high" },
    };
    const registry = new ToolRegistry({
      listAttachments: async () => ({
        items: [],
        totalAvailable: 0,
        offset: 0,
        nextOffset: null,
      }),
    } as any);
    (registry as any).sourceWhitelist.set(source.sourceID, source);
    const context: any = {
      userQuery: "这篇论文用了什么方法？",
      evidenceBudget: { remainingChars: 60000 },
      context: { refs: { items: [], attachments: [] } },
    };
    const args = {
      answer: "Thermal calibration [src-host52-calibration].",
      sourceIDs: [source.sourceID],
      evidenceInsufficient: false,
      evidenceFacts: [
        {
          sourceID: source.sourceID,
          quote: source.snippet,
          fact: "A thermal reference was used.",
          kind: "method",
        },
      ],
    };
    const rejected = await registry.execute(
      { id: "a", name: "finish_answer", arguments: args },
      context,
    );
    const action = (rejected.content as any).recovery?.requiredActions[0];
    if (rejected.ok || action?.tool !== "list_attachments")
      throw Error("Missing executable inventory recovery");
    const inventory = await registry.execute(
      { id: "b", name: action.tool, arguments: action.arguments },
      context,
    );
    if (!inventory.ok) throw Error("Synthetic inventory read failed");
    const accepted = await registry.execute(
      {
        id: "c",
        name: "finish_answer",
        arguments: { sourceIDs: args.sourceIDs, evidenceInsufficient: false },
      },
      context,
    );
    if (!accepted.ok || (accepted.content as any).answer !== args.answer)
      throw Error("Retained answer revalidation failed");
  });

  it("does not extend a figure caption into a later analysis subsection", function () {
    const text =
      "Figure 2 | Observations.\nIndividual values are plotted.\nStatistical analysis of observations\nWe fitted a regression to observations.";
    if (
      classifyPassage(text, text.indexOf("We fitted"), text.length).section !==
      "unknown"
    )
      throw Error("Caption crossed an unknown subsection");
    if (!methodScopeProblems("该分析只用于绘图。结尾：补充材料未读。", [], []).length)
      throw Error("Exclusive-purpose claim escaped scope checks");
  });
});
