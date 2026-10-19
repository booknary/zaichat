import { describe, expect, it } from "vitest";
import {
  candidateAllowance,
  fitCandidatesToEvidenceBudget,
  fitArrayToEvidenceBudget,
  jsonChars,
} from "../src/agent/evidenceBudget";
import { fitProviderMessages } from "../src/agent/agentRunner";

describe("model context budgets", () => {
  it("reserves verification space across candidate pages without increasing the total", () => {
    const budget = { remainingChars: 10_000 };
    const entries = Array.from({ length: 20 }, () => ({ text: "x".repeat(500) }));
    let used = 0;
    for (let page = 0; page < 10; page++) {
      used += fitCandidatesToEvidenceBudget(entries, budget, 3_000).usedChars;
    }
    expect(used).toBeLessThanOrEqual(6_000);
    expect(candidateAllowance(budget)).toBeLessThan(3_000);
    expect(budget.remainingChars).toBeGreaterThanOrEqual(4_000);
    const verified = fitArrayToEvidenceBudget(entries, budget, 4_000);
    expect(verified.content.items.length).toBeGreaterThan(0);
    expect(used + verified.usedChars + budget.remainingChars).toBe(10_000);
  });

  it.each(["verify_candidates", "read_abstracts"])(
    "retains %s evidence ahead of more recent candidate pages",
    (name) => {
      const exchange = (id: string, name: string, content: string) => [
        {
          role: "assistant" as const,
          content: "",
          reasoning_content: "reason",
          tool_calls: [{ id, function: { name } }],
          protocolRequired: true,
        },
        { role: "tool" as const, tool_call_id: id, content, protocolRequired: true },
      ];
      const messages = [
        { role: "system" as const, content: "system" },
        { role: "user" as const, content: "question" },
        ...exchange(
          "passages",
          name,
          JSON.stringify({
            items: [
              { [name === "read_abstracts" ? "abstract" : "text"]: "bounded evidence" },
            ],
          }),
        ),
        ...exchange("page", "next_search_results", "x".repeat(1200)),
        ...exchange("latest", "next_search_results", "done"),
      ];
      const fitted = fitProviderMessages(messages, 1700);
      expect(fitted.some((m) => m.tool_call_id === "passages")).toBe(true);
      expect(fitted.some((m) => m.tool_call_id === "latest")).toBe(true);
      expect(fitted.some((m) => m.tool_call_id === "page")).toBe(false);
      expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(1700);
      for (const [index, message] of fitted.entries()) {
        if (message.role === "tool") expect(fitted[index - 1]?.role).toBe("assistant");
      }
    },
  );
  it("retains a reading reserve after abstracts spend the shared balance", () => {
    const budget = { remainingChars: 60000 };
    candidateAllowance(budget);
    fitArrayToEvidenceBudget([{ text: "a".repeat(23000) }], budget, 24000);
    const entries = Array.from({ length: 20 }, () => ({ text: "x".repeat(500) }));
    for (let page = 0; page < 10; page++)
      fitCandidatesToEvidenceBudget(entries, budget, 8000);
    expect(budget.remainingChars).toBeGreaterThanOrEqual(12000);
    expect(
      fitArrayToEvidenceBudget([{ text: "v".repeat(4000) }], budget, 8000).content
        .items,
    ).toHaveLength(1);
  });
  it("keeps complete JSON entries within one shared evidence balance", () => {
    const budget = { remainingChars: 900 };
    const large = Array.from({ length: 50 }, (_, index) => ({
      id: index,
      text: "x".repeat(180),
    }));
    const first = fitArrayToEvidenceBudget(large, budget, 600);
    const second = fitArrayToEvidenceBudget(large, budget, 600);
    expect(jsonChars(first.content)).toBeLessThanOrEqual(600);
    expect(first.content.truncated).toBe(true);
    expect(first.content.items.length).toBeLessThan(50);
    expect(first.usedChars + second.usedChars).toBeLessThanOrEqual(900);
    expect(() => JSON.parse(JSON.stringify(first.content))).not.toThrow();
  });

  it("reports zero returned entries when only raw matches exist outside the budget", () => {
    const budget = { remainingChars: 0 };
    const fitted = fitArrayToEvidenceBudget([{ id: 1 }], budget, 600);
    expect(fitted.content).toMatchObject({
      items: [],
      totalAvailable: 1,
      truncated: true,
      evidenceDelivery: "budget-truncated",
    });
  });

  it("re-trims the complete request before every model call", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "old".repeat(200) },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [{ id: "t1", function: { name: "search_library" } }],
      },
      { role: "tool" as const, tool_call_id: "t1", content: "new".repeat(100) },
    ];
    const fitted = fitProviderMessages(messages, 700);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(700);
    expect(fitted[0].role).toBe("system");
    expect(fitted[1]?.role).not.toBe("tool");
  });

  it("drops old DeepSeek exchanges atomically while preserving the latest exchange", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "find the remembered paper" },
      {
        role: "assistant" as const,
        content: "",
        reasoning_content: "old reasoning ".repeat(90),
        tool_calls: [{ id: "old", function: { name: "plan_search" } }],
        protocolRequired: true,
      },
      {
        role: "tool" as const,
        tool_call_id: "old",
        content: "old candidates ".repeat(50),
        protocolRequired: true,
      },
      {
        role: "assistant" as const,
        content: "",
        reasoning_content: "latest reasoning ".repeat(30),
        tool_calls: [{ id: "latest", function: { name: "verify_candidates" } }],
        protocolRequired: true,
      },
      {
        role: "tool" as const,
        tool_call_id: "latest",
        content: "verified evidence ".repeat(20),
        protocolRequired: true,
      },
      { role: "system" as const, content: "Now synthesize the verified answer." },
    ];

    const fitted = fitProviderMessages(messages, 2_000);
    const serialized = JSON.stringify(fitted);
    expect(serialized).toContain('"id":"latest"');
    expect(serialized).toContain('"tool_call_id":"latest"');
    expect(serialized).not.toContain('"id":"old"');
    expect(serialized).not.toContain('"tool_call_id":"old"');
    expect(fitted.find((message) => message.role === "user")?.content).toContain(
      "remembered paper",
    );
    for (const [index, message] of fitted.entries()) {
      if (message.role === "tool") expect(fitted[index - 1]?.role).toBe("assistant");
    }
  });
});
