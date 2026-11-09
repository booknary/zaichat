import type { SourceReference } from "../core/types";
import { answerSentences, type EvidenceProblem } from "./answerClaims";
import type { EvidenceFact } from "./methodEvidence";

/** Flags a narrow set of exclusive-purpose claims, not all uses of 'only'. */
export function methodScopeProblems(
  answer: string,
  sources: SourceReference[],
  facts: EvidenceFact[],
): EvidenceProblem[] {
  return answerSentences(answer)
    .flatMap((sentence) => {
      const text = sentence.replace(/\*|\[src-[\w-]+\]/gu, "");
      const exclusive =
        /(?:只|仅)(?:是|用于|用来|提供|服务于)|纯属|不在.{0,8}(?:SI|补充材料|附录)|没有把.{0,35}(?:聚成|分成|模块|比较|分析)|\b(?:only (?:used|serves|provides)|purely (?:for|a)|not in (?:the )?supplement)\b/iu;
      if (!exclusive.test(text)) return [];
      const scoped =
        /(?:已读|已核查|已检查|当前|返回的).{0,14}(?:片段|段落|图注|证据)|(?:无法|不能|尚未|未能).{0,10}(?:确认|确定|断言)|\b(?:checked|read|returned) (?:passages|captions|evidence)|\bcannot (?:confirm|establish)\b/iu;
      if (scoped.test(text)) return [];
      const direct = facts.some((fact) => {
        if (!fact || typeof fact.quote !== "string" || typeof fact.fact !== "string")
          return false;
        const source = sources.find((entry) => entry.sourceID === fact.sourceID);
        return (
          sentence.includes(fact.sourceID) &&
          sentence.includes(fact.fact) &&
          source?.provenance?.section !== "references" &&
          /\bonly\b|\bsolely\b|仅|只用于/iu.test(fact.quote) &&
          source?.snippet?.includes(fact.quote)
        );
      });
      return direct
        ? []
        : [
            {
              code: "unscoped-method-purpose",
              claim: sentence.trim().slice(0, 800),
              message:
                "A described use does not establish the paper's only use or exclude supplementary analyses. Qualify this claim with the checked passage/caption, or cite an explicit statement of exclusive purpose. A closing caveat cannot repair it.",
            },
          ];
    })
    .slice(0, 8);
}
