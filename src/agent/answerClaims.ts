import type { SourceReference } from "../core/types";

export interface EvidenceProblem {
  code: string;
  message: string;
  factIndex?: number;
  sourceID?: string;
  claim?: string;
}

export function answerSentences(answer: string): string[] {
  return answer.split(/[。！？!?\n]|(?<=[a-z])\.\s+(?=[A-Z])/u);
}

/** A narrow linguistic guard, not an automated test of scientific causality. */
export function causalClaimProblems(
  answer: string,
  sources: SourceReference[],
): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];
  for (const sentence of answerSentences(answer)) {
    const claims = [
      ...sentence.matchAll(
        /因果(?:方向|箭头|关系).{0,16}(?:是|为|相反|反过来)|(?:作为|是)(?:直接)?原因|(?:证明|证实).{0,20}(?:导致|因果)|\b(?:prove[sd]?|establish(?:es|ed)?|demonstrat(?:es|ed)).{0,30}\bcausal|\b(?:is the cause|as the cause)\b/giu,
      ),
    ];
    if (
      !claims.some((claim) => {
        const prefix = sentence.slice(Math.max(0, claim.index! - 18), claim.index);
        return !/不能|无法|未能|尚未|不等于|不是|并非|\b(?:not|cannot|without)\b/iu.test(
          prefix,
        );
      })
    )
      continue;
    if (
      /需要.{0,12}(?:研究|设计)|如果|假设|\b(?:hypothesi[sz]e|hypothetical|whether)\b/iu.test(
        sentence,
      )
    )
      continue;
    const ids: string[] = sentence.match(/src-[a-zA-Z0-9_-]+/gu) || [];
    const evidence = sources.filter(
      (source) =>
        source.snippet &&
        source.provenance?.section !== "references" &&
        (!ids.length || ids.includes(source.sourceID)),
    );
    if (
      evidence.some(
        (source) =>
          /\b(?:associat(?:ed|ion)|correlat(?:ed|ion)|statistically linked)\b|相关|关联/iu.test(
            source.snippet!,
          ) &&
          ![
            ...source.snippet!.matchAll(
              /\b(?:causal evidence|causally|caused by|causes?)\b|因果证据|证明.{0,12}因果/giu,
            ),
          ].some(
            (marker) =>
              !/\b(?:no|not|without|cannot|lack(?:s|ing|ed)?)\b|没有|无法|不能|缺乏/iu.test(
                source.snippet!.slice(Math.max(0, marker.index! - 24), marker.index),
              ),
          ),
      )
    )
      problems.push({
        code: "association-not-causation",
        claim: sentence.trim().slice(0, 800),
        message:
          "Association evidence does not establish causality. Describe the study's tested association/direction, not a proved causal arrow. Qualify this claim itself or cite direct causal evidence.",
      });
  }
  return problems.slice(0, 8);
}
