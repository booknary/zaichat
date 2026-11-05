import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, fitProviderMessages } from "../src/agent/agentRunner";
import { OpenAICompatibleProvider, ProviderMessage } from "../src/agent/modelProvider";
import type { ModelProfile, ToolCall } from "../src/core/types";

const profile: ModelProfile = {
  id: "empty-reasoning-test",
  displayName: "DeepSeek test",
  baseURL: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-flash",
  protocol: "native-tools",
  streaming: false,
  reasoningEnabled: true,
  reasoningEffort: "high",
  timeoutMs: 5000,
  contextBudgetChars: 100000,
  evidenceBudgetChars: 60000,
};
const definitions = ["search_authors", "finish_answer"].map((name) => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([false, true])("DeepSeek empty reasoning (stream=%s)", (streaming) => {
  it.each(
    ["deepseek-flash", "deepseek-v4-flash"].flatMap((model) =>
      ["", null, undefined].map((reasoning) => ({ model, reasoning })),
    ),
  )("round-trips $model with reasoning=$reasoning", async ({ model, reasoning }) => {
    const bodies = mockProvider(streaming, [
      message("call-1", "search_authors", reasoning),
      message("call-2", "search_authors", "Exact subsequent reasoning"),
      { role: "assistant", content: "Completed", reasoning_content: "Final reasoning" },
    ]);
    const provider = new OpenAICompatibleProvider();
    const messages: ProviderMessage[] = [{ role: "user", content: "Find an author" }];
    for (const callID of ["call-1", "call-2"]) {
      const result = await provider.complete(
        { ...profile, streaming, model },
        fitProviderMessages(messages, 50000),
        definitions,
        new AbortController().signal,
      );
      if (callID === "call-1")
        expect(result.assistantMessage.reasoning_content).toBe("");
      messages.push(
        { ...result.assistantMessage, protocolRequired: true },
        { role: "tool", tool_call_id: callID, content: "{}", protocolRequired: true },
      );
    }
    const final = await provider.complete(
      { ...profile, streaming, model },
      fitProviderMessages(messages, 50000),
      definitions,
      new AbortController().signal,
    );
    expect(final.text).toBe("Completed");
    const history = bodies[2].messages.filter((entry: any) => entry.tool_calls);
    expect(history.map((entry: any) => entry.reasoning_content)).toEqual([
      "",
      "Exact subsequent reasoning",
    ]);
    expect(history.map((entry: any) => entry.tool_calls[0].id)).toEqual([
      "call-1",
      "call-2",
    ]);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("high");
      expect(body.stream).toBe(streaming);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not inject DeepSeek-only empty fields for generic endpoints", async () => {
    const bodies = mockProvider(streaming, [
      message("generic-call", "search_authors", ""),
      { role: "assistant", content: "Completed" },
    ]);
    const provider = new OpenAICompatibleProvider();
    const generic = { ...profile, streaming, baseURL: "https://example.test/v1" };
    const first = await provider.complete(
      generic,
      [],
      definitions,
      new AbortController().signal,
    );
    await provider.complete(
      generic,
      [
        first.assistantMessage,
        { role: "tool", tool_call_id: "generic-call", content: "{}" },
      ],
      definitions,
      new AbortController().signal,
    );
    expect(bodies[1].messages[0]).not.toHaveProperty("reasoning_content");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("completes the Agent loop after an empty-reasoning author lookup", async () => {
    const bodies = mockProvider(streaming, [
      message("lookup", "search_authors", ""),
      message("finish", "finish_answer", "", { answer: "No author matches verified" }),
    ]);
    const result = await runAgent({ ...profile, streaming });
    expect(result.run.status).toBe("completed");
    expect(result.answer).toBe("No author matches verified");
    expect(result.run.toolCallCount).toBe(2);
    expect(bodies).toHaveLength(2);
    expect(
      bodies[1].messages.find((entry: any) => entry.tool_calls).reasoning_content,
    ).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("rejects genuinely incomplete input history without leaking timers or listeners", async () => {
  const controller = new AbortController();
  const addListener = vi.spyOn(controller.signal, "addEventListener");
  vi.stubGlobal("fetch", vi.fn());
  await expect(
    new OpenAICompatibleProvider().complete(
      profile,
      [message("incomplete", "search_authors", undefined)],
      definitions,
      controller.signal,
    ),
  ).rejects.toThrow("missing reasoning_content");
  expect(fetch).not.toHaveBeenCalled();
  expect(addListener).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("shows the actual failure alongside partial progress and in Agent events", async () => {
  const bodies = mockProvider(false, [
    { ...message("lookup", "search_authors", "Plan"), content: "Checking authors" },
    new Response("{}", { status: 401 }),
  ]);
  const result = await runAgent(profile);
  expect(result.run.status).toBe("failed");
  expect(result.answer).toContain("Checking authors");
  expect(result.answer).toContain("Authentication failed (HTTP 401)");
  expect(
    result.run.events.some(
      (entry) =>
        entry.type === "error" &&
        entry.summary.includes("Authentication failed (HTTP 401)"),
    ),
  ).toBe(true);
  expect(bodies).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

function message(
  id: string,
  name: string,
  reasoning: string | null | undefined,
  args: Record<string, unknown> = {},
) {
  return {
    role: "assistant" as const,
    content: "",
    ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
    tool_calls: [
      { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

function mockProvider(streaming: boolean, messages: any[]) {
  const bodies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const next = messages.shift();
      if (!next) throw new Error("Unexpected extra model request");
      if (next instanceof Response) return next;
      if (!streaming)
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: next,
                finish_reason: next.tool_calls ? "tool_calls" : "stop",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      const delta = {
        ...next,
        ...(next.tool_calls
          ? {
              tool_calls: next.tool_calls.map((call: any, index: number) => ({
                ...call,
                index,
              })),
            }
          : {}),
      };
      const payload = `data: ${JSON.stringify({
        choices: [{ delta, finish_reason: next.tool_calls ? "tool_calls" : "stop" }],
      })}\n\ndata: [DONE]\n\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }),
  );
  return bodies;
}

async function runAgent(modelProfile: ModelProfile) {
  const tools = {
    clearSources: vi.fn(),
    definitions: () => definitions,
    execute: async (call: ToolCall) => ({
      toolCallID: call.id,
      name: call.name,
      ok: true,
      sources: [],
      resultCount: 0,
      content: call.name === "finish_answer" ? call.arguments : { items: [] },
      summary: call.name === "finish_answer" ? "Answer completed" : "No author matches",
    }),
  };
  return new AgentRunner(new OpenAICompatibleProvider(), tools as any).run(
    "synthetic-conversation",
    [
      {
        id: "user",
        role: "user",
        displayText: "Find an author",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      refs: { items: [], attachments: [], notes: [], annotations: [], collections: [] },
    },
    modelProfile,
    "Test system",
    { maxToolCalls: 80, maxAttachments: 20 },
    {
      onRun: vi.fn(),
      onAssistantDelta: vi.fn(),
      onToolResult: vi.fn(),
      onApproval: vi.fn(),
    },
  );
}
