import { expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agentRunner";
import { ToolRegistry } from "../src/agent/toolRegistry";
import type { AgentRun, ModelProfile, ToolCall } from "../src/core/types";

const profile: ModelProfile = {
  id: "test",
  displayName: "Test",
  baseURL: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-flash",
  protocol: "native-tools",
  streaming: true,
  reasoningEnabled: true,
  reasoningEffort: "high",
  timeoutMs: 5000,
  contextBudgetChars: 100000,
  evidenceBudgetChars: 60000,
};
const source = {
  sourceID: "src-synthetic",
  item: { libraryID: 1, itemKey: "SYNTH001" },
  label: "Synthetic paper",
};
const update = (id: string, text: string) => ({ id, text, context: context() });
const definitions = [
  "search_authors",
  "finish_answer",
  "request_clarification",
  "propose_add_tags",
  "propose_create_note",
].map((name) => ({ type: "function", function: { name } }));
function context() {
  return {
    refs: { items: [], attachments: [], notes: [], annotations: [], collections: [] },
  };
}
function response(id: string, name: string, args: unknown = {}) {
  return {
    text: "",
    reasoningContent: "",
    toolCalls: [{ id, name, arguments: args }],
    assistantMessage: {
      role: "assistant",
      content: "",
      reasoning_content: "",
      tool_calls: [
        { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    protocol: "native-tools",
  };
}
function tools() {
  return {
    clearSources: vi.fn(),
    acceptUserGuidance: vi.fn(),
    definitions: () => definitions,
    execute: vi.fn(async (call: ToolCall) => ({
      toolCallID: call.id,
      name: call.name,
      ok: true,
      content:
        call.name === "finish_answer"
          ? { answer: "Verified [src-synthetic]" }
          : { items: [{ item: source.item, sourceID: source.sourceID }] },
      summary: "Synthetic tool completed",
      sources: [source],
      resultCount: 1,
    })),
  };
}
function run(runner: AgentRunner, callbacks: any = {}, query = "Find author Example") {
  return runner.run(
    "chat",
    [
      {
        id: "user",
        role: "user",
        displayText: query,
        createdAt: new Date().toISOString(),
      },
    ],
    context(),
    profile,
    "Test",
    { maxToolCalls: 80, maxAttachments: 20 },
    {
      onRun: vi.fn(),
      onAssistantDelta: vi.fn(),
      onToolResult: vi.fn(),
      onApproval: vi.fn(),
      ...callbacks,
    },
  );
}

it("interrupts in-flight generation, retains complete evidence and applies new user input", async () => {
  const requests: any[] = [];
  const provider = {
    complete: vi.fn(async (_p, messages, _tools, signal, onDelta) => {
      requests.push({ messages, signal });
      if (requests.length === 1) return response("lookup", "search_authors");
      if (requests.length === 2) {
        onDelta("Obsolete draft");
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      }
      return response("finish", "finish_answer");
    }),
  };
  const registry = tools();
  const runner = new AgentRunner(provider as any, registry as any);
  const applied = vi.fn(),
    reset = vi.fn();
  const result = run(runner, { onSteeringApplied: applied, onAssistantReset: reset });
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  runner.steer(update("u2", "The name may be abbreviated"));
  runner.steer(update("u3", "Only the first author"));
  const completed = await result;
  expect(completed.run.status).toBe("completed");
  expect(completed.answer).not.toContain("Obsolete");
  expect(completed.sources[0].sourceID).toBe(source.sourceID);
  expect(requests[1].signal.aborted).toBe(true);
  expect(
    requests[2].messages.some(
      (entry: any) => entry.role === "user" && entry.content.includes("abbreviated"),
    ),
  ).toBe(true);
  const currentTask = requests[2].messages
    .filter((entry: any) => entry.role === "user")
    .at(-1).content;
  expect(currentTask).toContain("Find author Example");
  expect(currentTask).toContain("The name may be abbreviated");
  expect(currentTask).toContain("Only the first author");
  expect(
    requests[2].messages.some((entry: any) => entry.tool_call_id === "lookup"),
  ).toBe(true);
  expect(applied).toHaveBeenCalledWith(["u2", "u3"]);
  expect(reset).toHaveBeenCalled();
  expect(completed.run.toolCallCount).toBe(2);
});

it("does not execute the rest of a stale tool batch after guidance arrives", async () => {
  let finishTool!: () => void;
  const registry = tools();
  registry.execute.mockImplementationOnce(async (call) => {
    await new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    return {
      toolCallID: call.id,
      name: call.name,
      ok: true,
      content: {},
      summary: "Read",
      sources: [source],
      resultCount: 1,
    };
  });
  const batch = response("one", "search_authors");
  const second = response("two", "search_authors");
  batch.toolCalls.push(second.toolCalls[0]);
  batch.assistantMessage.tool_calls.push(second.assistantMessage.tool_calls[0]);
  const received: any[][] = [];
  const provider = {
    complete: vi.fn(async (_p, messages) => {
      received.push(messages);
      return received.length === 1 ? batch : response("finish", "finish_answer");
    }),
  };
  const runner = new AgentRunner(provider as any, registry as any);
  const result = run(runner);
  await vi.waitFor(() => expect(finishTool).toBeTypeOf("function"));
  runner.steer(update("new", "Use a different author"));
  finishTool();
  expect((await result).run.status).toBe("completed");
  expect(registry.execute.mock.calls.map(([call]) => call.id)).not.toContain("two");
  expect(
    received[1]
      .filter((entry) => entry.role === "tool")
      .map((entry) => entry.tool_call_id),
  ).toEqual(["one", "two"]);
});

it("waits for an explicit clarification reply and preserves its tool-result pairing", async () => {
  const registry = tools();
  registry.execute.mockImplementationOnce(
    async (call) =>
      ({
        toolCallID: call.id,
        name: call.name,
        ok: true,
        content: {},
        summary: "Question",
        sources: [],
        resultCount: 0,
        question: {
          id: call.id,
          question: "Full name or initials?",
          choices: ["Full name", "Initials"],
        },
      }) as any,
  );
  const requests: any[][] = [],
    states: string[] = [];
  const provider = {
    complete: vi.fn(async (_p, messages) => {
      requests.push(messages);
      return requests.length === 1
        ? response("q", "request_clarification")
        : response("finish", "finish_answer");
    }),
  };
  const runner = new AgentRunner(provider as any, registry as any);
  const question = vi.fn();
  const result = run(runner, {
    onQuestion: question,
    onRun: (state: AgentRun) => states.push(state.status),
  });
  await vi.waitFor(() => expect(states).toContain("waiting-user"));
  expect(requests).toHaveLength(1);
  runner.steer(update("reply", "Initials"));
  expect((await result).run.status).toBe("completed");
  expect(
    JSON.parse(requests[1].find((entry) => entry.tool_call_id === "q").content).answer,
  ).toBe("Initials");
  expect(question).toHaveBeenLastCalledWith(undefined);
});

it("cancels a waiting question without performing more tools or model requests", async () => {
  const registry = tools();
  registry.execute.mockImplementationOnce(
    async (call) =>
      ({
        toolCallID: call.id,
        name: call.name,
        ok: true,
        content: {},
        summary: "Question",
        sources: [],
        resultCount: 0,
        question: { id: call.id, question: "Which scope?", choices: [] },
      }) as any,
  );
  const provider = {
    complete: vi.fn(async () => response("q", "request_clarification")),
  };
  const question = vi.fn();
  const runner = new AgentRunner(provider as any, registry as any);
  const result = run(runner, { onQuestion: question });
  await vi.waitFor(() =>
    expect(question).toHaveBeenCalledWith(expect.objectContaining({ id: "q" })),
  );
  runner.cancel();
  const cancelled = await result;
  expect(cancelled.run.status).toBe("cancelled");
  expect(provider.complete).toHaveBeenCalledTimes(1);
  expect(
    cancelled.protocolHistory?.some(
      (entry) => entry.role === "tool" && entry.toolCallID === "q",
    ),
  ).toBe(true);
});

it("validates clarification through the same registry as other tools", async () => {
  const registry = new ToolRegistry({} as any);
  const execution = {
    conversationID: "test",
    context: context(),
    maxAttachments: 20,
    evidenceBudget: { remainingChars: 60000 },
  };
  expect(
    (
      await registry.execute(
        {
          id: "q",
          name: "request_clarification",
          arguments: { question: "Scope?", choices: ["One", "Two"] },
        },
        execution,
      )
    ).question?.choices,
  ).toEqual(["One", "Two"]);
  expect(
    (
      await registry.execute(
        {
          id: "bad",
          name: "request_clarification",
          arguments: { question: "", choices: [] },
        },
        execution,
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await registry.execute(
        {
          id: "extra",
          name: "request_clarification",
          arguments: { question: "Scope?", execute: true },
        },
        execution,
      )
    ).ok,
  ).toBe(false);
});

it("does not expand the original write permissions when new guidance arrives", async () => {
  const exposed: string[][] = [];
  const provider = {
    complete: vi.fn(async (_p, _messages, available, signal) => {
      exposed.push(available.map((entry: any) => entry.function.name));
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    }),
  };
  const runner = new AgentRunner(provider as any, tools() as any);
  const result = run(runner, {}, "Add review tags to the selected paper");
  await vi.waitFor(() => expect(exposed).toHaveLength(1));
  runner.steer(update("update", "Also create a child note"));
  await vi.waitFor(() => expect(exposed).toHaveLength(2));
  expect(exposed[1]).toContain("propose_add_tags");
  expect(exposed[1]).not.toContain("propose_create_note");
  runner.cancel();
  expect((await result).run.status).toBe("cancelled");
});

it("delivers unresolved-reference guidance and waits through the real clarification registry", async () => {
  const registry = new ToolRegistry({} as any);
  const requests: any[][] = [];
  const provider = {
    complete: vi.fn(async (_p, messages, available) => {
      requests.push(messages);
      expect(
        available.some((tool: any) => tool.function.name === "request_clarification"),
      ).toBe(true);
      return requests.length === 1
        ? response("scope", "request_clarification", {
            question: "Do you mean model construction or evaluation?",
            choices: ["Construction", "Evaluation"],
          })
        : response("finish", "finish_answer", {
            answer: "No evidence was read in this synthetic scope check.",
            sourceIDs: [],
            evidenceInsufficient: true,
          });
    }),
  };
  const runner = new AgentRunner(provider as any, registry);
  const onQuestion = vi.fn();
  const pending = run(runner, { onQuestion }, "还有别的这种分析吗？");
  await vi.waitFor(() =>
    expect(onQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "Do you mean model construction or evaluation?",
      }),
    ),
  );
  expect(provider.complete).toHaveBeenCalledTimes(1);
  expect(requests[0][0].content).toContain("Do not invent a missing reference");
  runner.steer(update("scope-reply", "Evaluation"));
  expect((await pending).run.status).toBe("completed");
  expect(
    JSON.parse(requests[1].find((entry: any) => entry.tool_call_id === "scope").content)
      .answer,
  ).toBe("Evaluation");
});
