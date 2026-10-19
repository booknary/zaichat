import { AgentEvent } from "../core/types";

export function compactAgentEvents(events: AgentEvent[]): AgentEvent[] {
  const compact: Array<AgentEvent & { count: number }> = [];
  const bySignature = new Map<string, number>();

  for (let index = 0; index < events.length; index++) {
    const current = events[index];
    const next = events[index + 1];
    if (
      current.type === "tool-call" &&
      next?.type === "error" &&
      current.name === next.name
    ) {
      continue;
    }

    const signature = `${current.type}:${current.name || ""}:${current.summary}`;
    const existingIndex = bySignature.get(signature);
    if (existingIndex !== undefined) {
      compact[existingIndex].count++;
      continue;
    }
    bySignature.set(signature, compact.length);
    compact.push({ ...current, count: 1 });
  }

  return compact.map(({ count, ...current }) => ({
    ...current,
    summary: count > 1 ? `${current.summary} ×${count}` : current.summary,
  }));
}
