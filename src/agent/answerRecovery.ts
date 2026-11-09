import type { SourceReference } from "../core/types";
import type { EvidenceProblem } from "./answerClaims";

/** Recovery describes missing work; it never accepts a rejected claim. */
export function answerRecovery(
  problems: EvidenceProblem[],
  sources: SourceReference[],
  missingInventories: SourceReference[] = [],
  needsFacts = false,
) {
  const missingPassages = sources.filter((source) =>
    problems.some(
      (problem) =>
        problem.code === "missing-passage" && problem.sourceID === source.sourceID,
    ),
  );
  const actions: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  for (const source of missingInventories) {
    const key = source.item.libraryID + ":" + source.item.itemKey;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({ tool: "list_attachments", arguments: { ref: source.item } });
  }
  if (missingPassages.length)
    actions.push({
      tool: "verify_candidates",
      arguments: {
        sourceIDs: missingPassages.map((source) => source.sourceID).slice(0, 4),
      },
    });
  return {
    kind: actions.length ? "read-evidence" : "edit-draft",
    requiredActions: actions.slice(0, 6),
    needsEvidenceFacts: needsFacts,
    instruction: actions.length
      ? "Run the listed read tools for the missing evidence within the existing budget, then repair the retained draft. Do not repeatedly resubmit unchanged claims. If verification cannot be completed, finish with candidateOnly=true and current candidate sourceIDs; the program will show an explicitly unverified candidate list."
      : "Reuse delivered passages to fix the reported quotes/claims. Omit answer to reuse the retained draft; submit repair.answerPatches and/or evidenceFacts plus sourceIDs and evidenceInsufficient. To remove invalid facts explicitly send evidenceFacts=[]. Read only if supporting evidence is actually missing. All checks run again. candidateOnly=true is available for an explicitly unverified candidate list.",
  };
}

export function candidateOnlyAnswer(sources: SourceReference[], query: string): string {
  const chinese = /[\u3400-\u9fff]/u.test(query);
  const seen = new Set<string>();
  const rows = sources
    .filter((source) => {
      const key = source.item.libraryID + ":" + source.item.itemKey;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5)
    .map((source) => {
      const title = (source.item.title || source.label || source.item.itemKey)
        .replace(/[\r\n]+/gu, " ")
        .replace(/[[\]<>*_~`]/gu, "");
      return "- " + title + " [" + source.sourceID + "]";
    });
  return (
    (chinese
      ? "找到以下待核实候选，但本轮未完成所问方法或结论的证据核验："
      : "These are unverified candidates; this run did not complete verification of the requested method or finding:") +
    "\n\n" +
    rows.join("\n") +
    "\n\n" +
    (chinese
      ? "题录或检索命中不能证明论文实际采用了该方法；核验未完成也不代表文库中没有符合条件的文献。"
      : "Metadata or search matches do not establish method use. Incomplete verification does not establish absence from the library.")
  );
}
