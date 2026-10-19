import { StoredMessage } from "../core/types";

export function isPagingFollowup(query: string): boolean {
  return /^(?:请)?(?:继续|接着)(?:翻|查看|看|读).*(?:候选|剩余|下一页)|^(?:please\s+)?(?:continue|resume)\s+(?:paging|browsing|the remaining)/iu.test(
    query.trim(),
  );
}

/** Resolve only an exact collection name actually returned in the preceding turn. */
export function collectionFollowup(messages: StoredMessage[]): boolean {
  const current = messages.at(-1);
  const previous = messages.slice(0, -1).at(-1);
  if (current?.role !== "user" || previous?.role !== "assistant" || previous.error)
    return false;
  if (!previous.agentEvents?.some((event) => event.name === "list_collections"))
    return false;
  const query = current.displayText.trim().toLocaleLowerCase();
  return (previous.protocolHistory || []).some((entry) => {
    if (entry.role !== "tool") return false;
    let content;
    try {
      content = JSON.parse(entry.content);
    } catch {
      // Older or truncated tool history is not usable for exact-name routing.
      return false;
    }
    return (
      Array.isArray(content.items) &&
      content.items.some(
        (item: any) =>
          typeof item.key === "string" &&
          typeof item.name === "string" &&
          item.name.trim().toLocaleLowerCase() === query,
      )
    );
  });
}
