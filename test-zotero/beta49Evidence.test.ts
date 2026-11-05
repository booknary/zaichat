import { ToolRegistry } from "../src/agent/toolRegistry";
import { candidateExcerpt, candidateAuthors } from "../src/utils/candidatePreview";
import { coverageClaimProblems } from "../src/agent/coverageClaims";

describe("Beta 49 evidence contracts", function () {
  it("repairs a fact-only submission with a unique short source ID in the host", async function () {
    const registry = new ToolRegistry({} as any);
    const source = {
      sourceID: "src-host49-analysis",
      item: { libraryID: 1, itemKey: "TEST0049" },
      label: "Synthetic host evidence",
      field: "fulltext",
      snippet: "We calibrated the sensor with a thermal reference.",
      provenance: { section: "methods", basis: "heading", confidence: "high" },
    };
    (registry as any).sourceWhitelist.set(source.sourceID, source);
    const context: any = {
      userQuery: "How was calibration performed?",
      evidenceBudget: { remainingChars: 60000 },
    };
    const finish = (args: any) =>
      registry.execute({ id: "f", name: "finish_answer", arguments: args }, context);
    const base = { sourceIDs: ["src-host49-analy"], evidenceInsufficient: false };
    const fact = {
      sourceID: "src-host49-analy",
      quote: source.snippet,
      fact: "A thermal reference was used.",
      kind: "method",
    };
    const bad = await finish({
      ...base,
      answer: "Thermal calibration [src-host49-analy].",
      evidenceFacts: [
        { ...fact, quote: "An invented quote that is not in this evidence." },
      ],
    });
    const good = await finish({ ...base, evidenceFacts: [fact] });
    if (bad.ok || !good.ok || !(good.content as any).answer.includes(source.sourceID))
      throw new Error("Host fact-only citation repair failed");
    if ((await finish({ ...base, evidenceFacts: [fact] })).ok)
      throw new Error("Completed draft leaked into another repair");
  });

  it("rejects unbounded uniqueness while allowing a scoped partial answer", function () {
    if (
      !coverageClaimProblems("这是本库唯一符合要求的研究。结尾：只读了部分候选。", 8)
        .length ||
      coverageClaimProblems("在本轮已检查的候选中，只有一篇明确符合要求。", 8).length
    )
      throw new Error("Host coverage guard failed");
  });

  it("preserves original late abstract wording and full author counts within existing preview limits", function () {
    const text =
      "General introduction. ".repeat(30) +
      "We did not use optical calibration; we used thermal calibration.";
    const excerpt = candidateExcerpt(
      text,
      ["thermal calibration", "optical calibration"],
      120,
    );
    const authors = candidateAuthors(
      { authors: Array.from({ length: 20 }, (_, i) => "Person " + i) },
      3,
    );
    if (
      !excerpt.includes("did not use optical calibration") ||
      excerpt.length > 120 ||
      authors.authorCount !== 20 ||
      !authors.authorsTruncated ||
      authors.authors.length !== 3
    )
      throw new Error("Host candidate preview contract failed");
  });
});
