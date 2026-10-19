import { ChatConversation } from "../core/types";
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
export function parseTokenUsage(value: any): TokenUsage | undefined {
  const valid = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  if (!value || !valid(value.prompt_tokens) || !valid(value.completion_tokens))
    return undefined;
  const total = valid(value.total_tokens)
    ? value.total_tokens
    : value.prompt_tokens + value.completion_tokens;
  return {
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    totalTokens: total,
  };
}
export function conversationUsage(conversation?: ChatConversation) {
  const events = [
    ...(conversation?.messages.flatMap((m) => m.agentEvents || []) || []),
    ...(conversation?.lastRun?.events || []),
  ];
  const seen = new Set<string>();
  const total = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reported: 0,
    missing: 0,
  };
  for (const event of events) {
    if (event.name !== "model-usage" || seen.has(event.id)) continue;
    seen.add(event.id);
    const usage = parseTokenUsage(event.details);
    if (!usage) {
      total.missing++;
      continue;
    }
    total.reported++;
    total.promptTokens += usage.promptTokens;
    total.completionTokens += usage.completionTokens;
    total.totalTokens += usage.totalTokens;
  }
  return total;
}
