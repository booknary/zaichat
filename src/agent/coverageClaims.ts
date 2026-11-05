import { answerSentences, type EvidenceProblem } from "./answerClaims";

/** Bounded linguistic guard; it does not establish scientific completeness. */
export function coverageClaimProblems(
  answer: string,
  remaining: number,
): EvidenceProblem[] {
  return answerSentences(answer)
    .flatMap((sentence) => sentence.split(/[；;]/u))
    .flatMap((sentence) => {
      const text = sentence.replace(/\[?src-[a-zA-Z0-9_-]+\]?/gu, "");
      const whole =
        /(?:本库|全库|整个文库|文库|库中|库里)|\b(?:the|your|our|entire) library\b/iu;
      const exclusive =
        /唯一(?:一篇|.{0,12}(?:文章|论文|研究|文献|工作|匹配))|(?:仅有|只有)\s*(?:一|1)\s*(?:篇|项)|\b(?:only (?:one|a single|paper|study|article|match)|sole (?:paper|study|match))\b/iu;
      const absent =
        /(?:没有|不存在).{0,20}(?:文章|论文|文献|研究|匹配项)|\b(?:no (?:such |other |matching )*(?:papers?|studies|articles?|matches)|none)\b/iu;
      const scope =
        /(?:本轮|当前|已)(?:.{0,12})(?:查看|检查|核查|核验|浏览|检索结果|候选|证据)|\b(?:checked|reviewed|inspected|returned|delivered) (?:papers?|candidates?|evidence|results?|subset)\b/iu;
      const uncertain =
        /(?:无法|不能|尚未|未能)(?:.{0,8})(?:确认|确定|断言)|不(?:能|代表|意味着)|\b(?:cannot|can't|could not|(?:does|do) not (?:mean|prove))\b/iu;
      if (
        remaining > 0 &&
        /已.{0,8}(?:全部|所有).{0,5}(?:翻完|看完|查看完)|\ball candidates (?:have been|were) reviewed\b/iu.test(
          text,
        ) &&
        !uncertain.test(text)
      )
        return [
          {
            code: "unseen-candidates",
            claim: sentence.trim().slice(0, 800),
            message:
              "Unseen candidates remain. Report the measured preview/read coverage; a supported partial answer may finish without exhausting the pool.",
          },
        ];
      const marker = exclusive.exec(text);
      const wholeAbsence = whole.test(text) && absent.test(text);
      const prefix = text.slice(0, marker?.index ?? text.length);
      const directWhole =
        /(?:本库|全库|文库|库中|库里)(?:中|里)?(?:确实|目前)?(?:唯一|仅有|只有|没有|不存在)|\b(?:only|sole).{0,60}\b(?:in|across) (?:the|your|our|entire) library\b/iu.test(
          text,
        );
      if (
        (marker || wholeAbsence) &&
        !uncertain.test(prefix) &&
        (directWhole || !scope.test(text))
      )
        return [
          {
            code: "unscoped-library-claim",
            claim: sentence.trim().slice(0, 800),
            message:
              "A bounded candidate search cannot establish library-wide uniqueness or absence. State the finding within the checked evidence in this claim, not only in a closing disclaimer. Preview delivery is not method verification.",
          },
        ];
      return [];
    })
    .slice(0, 8);
}
