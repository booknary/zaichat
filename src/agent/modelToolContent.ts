import type { ToolResult } from "../core/types";

// Keep full retrieval diagnostics in local events, not in every subsequent
// provider request. Candidates, source IDs, budgets and coverage stay intact.
export function modelToolContent(result: ToolResult): unknown {
  if (
    !result.ok ||
    result.name !== "plan_search" ||
    !result.content ||
    typeof result.content !== "object"
  )
    return result.content;
  const content = result.content as Record<string, any>;
  const {
    terminologyDiagnostics: _diagnostics,
    executedRecallTerms: _terms,
    plan,
    discovery,
    ...rest
  } = content;
  return {
    ...rest,
    plan: plan
      ? {
          id: plan.id,
          intent: plan.intent,
          discipline: plan.discipline,
          subfield: plan.subfield,
          concepts: (plan.concepts || []).map((concept: any) => ({
            label: concept.label,
            meaning: concept.meaning,
            role: concept.role,
          })),
          required: plan.required,
          excluded: plan.excluded,
          exactTitles: plan.exactTitles,
          filters: {
            authors: plan.authors,
            yearMin: plan.yearMin,
            yearMax: plan.yearMax,
            itemTypes: plan.itemTypes,
            languages: plan.languages,
            collectionKeys: plan.collectionKeys,
          },
          revisionReason: plan.revisionReason,
        }
      : undefined,
    discovery: discovery
      ? {
          exactTitleResolved: discovery.exactTitleResolved,
          scope: discovery.scope,
          fulltextDeferred: discovery.fulltextDeferred,
          metadataCandidates: discovery.metadataCandidates,
          fulltextCandidates: discovery.fulltextCandidates,
          semanticCandidates: discovery.semanticCandidates,
          unreadableItems: discovery.unreadableItems,
          semanticFailedRoutes: discovery.semanticFailedRoutes,
          degradedFields: discovery.degradedFields,
        }
      : undefined,
  };
}
