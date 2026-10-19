import { ToolResult } from "../core/types";
import { AgentStage } from "./providerCapabilities";
import { comparisonRequested } from "./comparisonLedger";

export type AgentState =
  | "context-inspection"
  | "direct-reading"
  | "feed-reading"
  | "search-planning"
  | "search-results-ready"
  | "evidence-verification"
  | "search-revision"
  | "evidence-ready"
  | "final-synthesis"
  | "write-proposal";

const SEARCH_RESULT_TOOLS = new Set([
  "expand_search",
  "list_attachments",
  "search_authors",
  "next_search_results",
  "verify_candidates",
  "read_attachment_snippets",
  "get_items",
  "read_abstracts",
  "search_fulltext",
  "plan_search",
  "finish_answer",
  "get_current_context",
  "list_item_notes",
  "list_item_annotations",
  "list_collections",
]);

export function initialAgentState(
  query: string,
  hasExplicitItems = false,
  hasExplicitCollection = false,
  allowDirectAbstract = true,
): AgentState {
  const reading =
    /总结|汇总|概览|列出|统计|翻译|比较|对比|读取|完整|summari[sz]e|overview|translate|compare|\blist\b/iu.test(
      query,
    );
  const collectionReading =
    reading &&
    (hasExplicitCollection ||
      /集合|文件夹|\bcollections?\b|\bfolders?\b/iu.test(query)) &&
    !/搜索|查找|找文献|search|\bfind\b/iu.test(query);
  const abstractReading =
    allowDirectAbstract &&
    hasExplicitItems &&
    reading &&
    /摘要|\babstracts?\b/iu.test(query);
  return requestedWriteTools(query).size
    ? "write-proposal"
    : /订阅|\brss\b|\bfeeds?\b/iu.test(query)
      ? "feed-reading"
      : collectionReading || abstractReading
        ? "direct-reading"
        : hasExplicitItems
          ? "context-inspection"
          : "search-planning";
}

export function toolsForAgentState(
  definitions: any[],
  state: AgentState,
  query: string,
): any[] {
  const allowed = new Set<string>();
  if (state === "direct-reading") {
    for (const name of [
      "list_collections",
      "read_collection_items",
      "read_abstracts",
      "list_attachments",
      "finish_answer",
    ])
      allowed.add(name);
  } else if (state === "feed-reading") {
    for (const name of [
      "list_feeds",
      "read_feed_items",
      "get_current_context",
      "finish_answer",
    ])
      allowed.add(name);
  } else if (state === "context-inspection") allowed.add("get_current_context");
  else if (state === "search-planning") {
    allowed.add("plan_search");
    allowed.add("search_authors");
  } else if (state === "search-revision") {
    // An empty/budget-limited page does not invalidate already resolved sources.
    for (const name of SEARCH_RESULT_TOOLS) allowed.add(name);
  } else if (
    ["search-results-ready", "evidence-verification", "evidence-ready"].includes(state)
  ) {
    for (const name of SEARCH_RESULT_TOOLS) allowed.add(name);
  } else if (state === "write-proposal") {
    allowed.add("get_current_context");
    for (const name of requestedWriteTools(query)) allowed.add(name);
  }
  if (!/(笔记|notes?)/iu.test(query)) allowed.delete("list_item_notes");
  if (!/(批注|标注|annotations?|highlights?)/iu.test(query))
    allowed.delete("list_item_annotations");
  if (
    state !== "direct-reading" &&
    !/(集合|文件夹|collections?|folders?)/iu.test(query)
  )
    allowed.delete("list_collections");
  if (
    comparisonRequested(query) &&
    [
      "search-results-ready",
      "evidence-verification",
      "evidence-ready",
      "direct-reading",
    ].includes(state)
  )
    allowed.add("record_comparison");
  return definitions.filter((entry) => allowed.has(entry.function?.name));
}

export function transitionAfterTool(state: AgentState, result: ToolResult): AgentState {
  if (!result.ok) return state;
  if (result.name === "search_authors") return "evidence-ready";
  if (result.name === "read_collection_items") return "direct-reading";
  if (result.name === "read_abstracts")
    return state === "direct-reading" ? state : "evidence-ready";
  if (
    ["list_feeds", "read_feed_items"].includes(result.name) ||
    (result.name === "get_current_context" && (result.content as any)?.feedMetadata)
  )
    return "feed-reading";
  if (
    result.name === "get_current_context" &&
    (state === "context-inspection" ||
      (state === "search-planning" && Boolean(result.resultCount)))
  )
    return "evidence-verification";
  if (["plan_search", "expand_search", "next_search_results"].includes(result.name))
    return result.resultCount ? "search-results-ready" : "search-revision";
  if (
    [
      "verify_candidates",
      "read_attachment_snippets",
      "get_items",
      "search_fulltext",
      "list_item_notes",
      "list_item_annotations",
    ].includes(result.name)
  )
    return result.resultCount || result.sources?.length
      ? "evidence-ready"
      : "evidence-verification";
  if (result.name === "finish_answer") return "final-synthesis";
  if (result.pendingBatch) return "write-proposal";
  return state;
}

export function stageForAgentState(state: AgentState): AgentStage {
  if (state === "search-planning") return "search-planning";
  if (state === "search-revision") return "search-revision";
  if (state === "write-proposal") return "write-proposal";
  if (state === "final-synthesis") return "final-synthesis";
  if (["evidence-verification", "evidence-ready"].includes(state))
    return "evidence-verification";
  return "tool-routing";
}

export function requiredActionForState(state: AgentState): string | undefined {
  if (state === "context-inspection")
    return "Call get_current_context to resolve the explicitly attached papers and their attachments before choosing verification or library search.";
  if (state === "search-planning")
    return "For author-only lookup call search_authors; otherwise call plan_search now.";
  if (state === "search-revision")
    return "Revise plan_search with a candidate-grounded revisionReason, or finish with evidenceInsufficient=true when no safe revision remains.";
  if (state === "write-proposal")
    return "Use only the exposed proposal tool for the explicit Zotero mutation request.";
  return undefined;
}

export function requestedWriteTools(query: string): Set<string> {
  const tools = new Set<string>();
  if (
    /(?:创建|新增|添加|写入|生成).{0,10}(?:子?笔记)|(?:create|add|write).{0,10}(?:child\s+)?note/iu.test(
      query,
    )
  )
    tools.add("propose_create_note");
  if (/(?:添加|新增|打上|写入).{0,8}(?:标签)|(?:add|apply).{0,8}tags?/iu.test(query))
    tools.add("propose_add_tags");
  if (
    /(?:建立|添加|创建).{0,10}(?:关联|相关条目|related)|(?:relate|link).{0,10}(?:items?|papers?)/iu.test(
      query,
    )
  )
    tools.add("propose_relate_items");
  return tools;
}
