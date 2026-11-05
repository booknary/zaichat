import React from "react";
import type { AgentRun } from "../core/types";
import { useMenuText } from "./menuLocale";

export function RunProgress({ run }: { run?: AgentRun }) {
  const t = useMenuText();
  if (!run) return null;
  const events = run.events.filter(
    (event) => !["diagnostic", "provider-reasoning"].includes(event.type),
  );
  const latestTool = [...events].reverse().find((event) => event.type === "tool-call");
  const labels: Record<string, string> = {
    plan_search: "Searching library",
    expand_search: "Expanding local search",
    search_authors: "Checking authors",
    read_abstracts: "Reading abstracts",
    verify_candidates: "Verifying evidence",
    read_attachment_snippets: "Reading passages",
    get_current_context: "Resolving context",
    search_fulltext: "Checking full-text index",
    finish_answer: "Preparing answer",
    request_clarification: "Waiting for your reply",
  };
  const latestAction = [...events]
    .reverse()
    .find((event) => event.type === "tool-call" || event.name === "user-guidance");
  const label =
    run.status === "waiting-user"
      ? "Waiting for your reply"
      : latestAction?.name === "user-guidance"
        ? "Updating task"
        : latestTool?.name === "request_clarification"
          ? "Working"
          : labels[latestTool?.name || ""] || "Working";
  return (
    <details className="zaichat-run-progress">
      <summary>
        <span className="zaichat-working-indicator" aria-hidden="true" />
        {t(label)}
        <span className="zaichat-progress-count">
          {run.toolCallCount} {t("tool calls")}
        </span>
      </summary>
      <div className="zaichat-progress-events">
        {events.slice(-8).map((event) => (
          <div key={event.id} data-error={event.type === "error"}>
            {t(event.summary)}
          </div>
        ))}
      </div>
    </details>
  );
}
