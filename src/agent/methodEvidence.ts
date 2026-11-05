import type { SourceReference } from "../core/types";
import { resolveCitationID } from "./citationRepair";
import { answerSentences, type EvidenceProblem } from "./answerClaims";

export interface EvidenceFact {
  sourceID: string;
  quote: string;
  fact: string;
  kind?: "method" | "result" | "mention" | "explicit-absence";
}

export function methodQuestion(query: string): boolean {
  if (
    /\b(?:find|search|locate)\b.{0,25}\b(?:paper|article)\b|(?:找|搜).{0,12}(?:文章|论文|文献)/iu.test(
      query,
    )
  )
    return false;
  return /方法|流程|步骤|怎么.{0,30}(?:进行|分析|做|重建)|如何.{0,30}(?:进行|分析|做|重建)|\bworkflow\b|\bmethods?\b|\bhow\b.{0,45}\b(?:perform|conduct|reconstruct|analy[sz]e|use)\b/iu.test(
    query,
  );
}

export function categoricalSupplementAbsence(answer: string): boolean {
  return answer
    .split(/[。！？!?\n]/u)
    .some(
      (sentence) =>
        /(?:库中|文库|附件|论文|该文|this paper|the library).{0,20}(?:没有|不存在|不含|no|does not have).{0,18}(?:补充材料|补充信息|附录|supplement)/iu.test(
          sentence,
        ) &&
        !/无法确认|不能确认|未能确认|明确标注|已核查|checked|cannot confirm/iu.test(
          sentence,
        ),
    );
}

const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
const negative =
  /(?:未|没有|不|并非|不是).{0,6}(?:进行|使用|采用|执行|靠)|\b(?:did not|does not|not performed|not used|without)\b/iu;

/** Resolve against the whole run whitelist, never an ambiguous cited subset. */
export function normalizeEvidenceFacts(
  facts: EvidenceFact[],
  sources: SourceReference[],
) {
  const problems: EvidenceProblem[] = [];
  const normalized = facts.map((fact, factIndex) => {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) return fact;
    const match = resolveCitationID(
      typeof fact.sourceID === "string" ? fact.sourceID : "",
      sources,
    );
    if (!match.sourceID) {
      problems.push({
        code: match.error,
        factIndex,
        sourceID: fact.sourceID,
        message:
          "Evidence fact sourceID is unknown or ambiguous. Use an exact current source ID; this is not a quote-text mismatch.",
      });
      return fact;
    }
    return { ...fact, sourceID: match.sourceID };
  });
  return { facts: normalized, problems };
}

export function evidenceFactProblems(
  sources: SourceReference[],
  facts: EvidenceFact[],
): EvidenceProblem[] {
  return facts.flatMap((fact, factIndex) => {
    if (!fact || typeof fact !== "object" || Array.isArray(fact))
      return [
        {
          code: "invalid-evidence-fact",
          factIndex,
          message:
            "Each evidence fact must be an object with sourceID, quote and an atomic fact.",
        },
      ];
    const source = sources.find((s) => s.sourceID === fact.sourceID);
    if (!source)
      return [
        {
          code: "uncited-source-id",
          factIndex,
          sourceID: fact.sourceID,
          message:
            "Evidence fact must reference a cited current source. Correct sourceIDs and the fact sourceID before checking quote text.",
        },
      ];
    if (
      !source?.snippet ||
      typeof fact.quote !== "string" ||
      fact.quote.trim().length < 12 ||
      typeof fact.fact !== "string" ||
      !fact.fact.trim() ||
      !normalize(source.snippet).includes(normalize(fact.quote))
    )
      return [
        {
          code: "quote-mismatch",
          factIndex,
          sourceID: fact.sourceID,
          message:
            "Method evidenceFacts must quote a cited current passage verbatim and state an atomic fact. Reuse existing evidence, not another search.",
        },
      ];
    if (source.provenance?.section === "references" && fact.kind !== "mention")
      return [
        {
          code: "reference-not-execution",
          factIndex,
          sourceID: fact.sourceID,
          message:
            "A reference-list quote supports a mention only, not method execution, version, parameters, or absence. Use a direct methods passage already returned, or label it kind=mention and limit the claim.",
        },
      ];
    return [];
  });
}

export function methodAbsenceProblems(
  answer: string,
  sources: SourceReference[],
  facts: EvidenceFact[],
): EvidenceProblem[] {
  const explicitAbsence = facts.filter(
    (fact) =>
      fact &&
      typeof fact.quote === "string" &&
      fact.kind === "explicit-absence" &&
      negative.test(fact.quote) &&
      sources.find((s) => s.sourceID === fact.sourceID)?.provenance?.section !==
        "references",
  );
  return answerSentences(answer)
    .flatMap((sentence) => {
      const categorical =
        /(?:本文|该文|这篇(?:文章|论文)|论文|该研究|作者|\b(?:this|the|that|another) (?:other )?(?:paper|study)|\bthe authors\b).{0,65}(?:未|没有|并非|不是|did not|does not|do not).{0,12}(?:进行|使用|采用|执行|靠|use|perform|conduct|apply)/iu.test(
          sentence,
        ) ||
        /(?:不是|并非|而非|没有|未).{0,8}(?:自己|自行|本文新|新跑).{0,8}(?:重建|估计|建模|分析|跑|进行)|没有任何.{0,8}(?:软件|模型|参数).{0,14}(?:用于|用来)|\b(?:not|rather than|instead of).{0,16}(?:newly|themselves).{0,12}(?:reconstruct|estimat|model|perform)/iu.test(
          sentence,
        );
      const scoped =
        /未能确认|无法确认|不能确认|未找到.{0,12}(?:明确|直接|说明|证据)|未见.{0,12}(?:明确|直接|说明|证据)|目前.{0,12}(?:证据|片段)|已核查.{0,16}(?:证据|片段)|\b(?:cannot confirm|could not establish|not found in (?:the )?(?:checked|returned)|checked (?:passages|evidence))\b/iu.test(
          sentence,
        );
      const directlyCited = explicitAbsence.some(
        (fact) =>
          sentence.includes(fact.sourceID) &&
          normalize(sentence).includes(normalize(fact.fact)),
      );
      if (!categorical || scoped || directlyCited) return [];
      return [
        {
          code: "unscoped-method-absence",
          claim: sentence.trim().slice(0, 800),
          message:
            "Bounded cache matching cannot prove the paper did not perform a method. State what was not established in checked passages, or supply an explicit-absence quote. Qualify the claim itself, not only a closing disclaimer.",
        },
      ];
    })
    .slice(0, 8);
}

export function methodEvidenceIssue(
  query: string,
  answer: string,
  sources: SourceReference[],
  facts: EvidenceFact[],
  insufficient: boolean,
  methodUseIntent = false,
): string | undefined {
  if (!methodUseIntent && !methodQuestion(query)) return undefined;
  const factIssue = evidenceFactProblems(sources, facts)[0];
  if (factIssue) return factIssue.message;
  const absenceIssue = methodAbsenceProblems(answer, sources, facts)[0];
  if (absenceIssue) return absenceIssue.message;
  if (insufficient) {
    for (const source of sources.filter(
      (s) => s.provenance?.section === "references",
    )) {
      if (
        answer
          .split(/[。！？!?\n]/u)
          .some(
            (sentence) =>
              sentence.includes(source.sourceID) &&
              /\b(?:used|uses|using|applied|performed|conducted|implemented)\b|(?:使用|采用|执行|参数|版本)/iu.test(
                sentence.replace(/\[?src-[a-zA-Z0-9_-]+\]?/gu, ""),
              ) &&
              !/参考文献|引用列表|仅.{0,8}提及|无法确认|不能确认|未能确认|references?|bibliograph|only mentioned|cannot confirm/iu.test(
                sentence.replace(/\[?src-[a-zA-Z0-9_-]+\]?/gu, ""),
              ),
          )
      )
        return "evidenceInsufficient cannot bypass citation provenance: a reference-list mention cannot substantiate execution/version/parameters. Cite direct evidence or qualify this exact claim.";
    }
    return undefined;
  }
  const papers = new Set(
    sources
      .filter((s) => s.field === "fulltext")
      .map((s) => `${s.item.libraryID}:${s.item.itemKey}`),
  );
  for (const key of papers) {
    const evidence = sources.filter(
      (s) => `${s.item.libraryID}:${s.item.itemKey}` === key && s.field === "fulltext",
    );
    if (evidence.every((s) => s.provenance?.section === "references"))
      return "Reference-list citations alone cannot answer how this paper performed its analysis. Cite the already returned contextual methods/results/figure evidence, or report evidenceInsufficient=true.";
    if (
      !facts.some(
        (fact) =>
          evidence.some(
            (s) =>
              s.sourceID === fact.sourceID && s.provenance?.section !== "references",
          ) && fact.kind !== "mention",
      )
    )
      return "For a methods/workflow answer, supply evidenceFacts for each cited paper: a direct current passage quote and atomic method/result fact. Reuse returned source IDs; unknown section labels do not certify execution.";
  }
  return undefined;
}
