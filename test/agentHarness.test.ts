import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agentRunner";
import {
  ModelProfile,
  PendingWriteBatch,
  ToolCall,
  ToolResult,
} from "../src/core/types";

describe("state-aware custom Agent harness", () => {
  it("F: allows a productive run to exceed ten tool calls", async () => {
    const responses = [toolResponse("plan", "plan_search", planArgs())];
    for (let index = 0; index < 12; index++)
      responses.push(
        toolResponse(`verify-${index}`, "verify_candidates", {
          sourceIDs: [`source-${index}`],
          terms: [`term-${index}`],
        }),
      );
    responses.push(
      toolResponse("finish", "finish_answer", {
        answer: "Productive long run completed.",
        sourceIDs: [],
        evidenceInsufficient: false,
      }),
    );
    const harness = createHarness(responses, { productiveVerification: true });
    const result = await run(harness, "Find and verify a complex literature set");
    expect(result.run.toolCallCount).toBeGreaterThan(10);
    expect(result.run.status).toBe("completed");
    expect(result.answer).toContain("Productive long run completed");
  });

  it("G: stops a synthetic endless productive loop at the emergency fuse", async () => {
    const responses = [toolResponse("plan", "plan_search", planArgs())];
    for (let index = 0; index < 70; index++)
      responses.push(
        toolResponse(`verify-${index}`, "verify_candidates", {
          sourceIDs: [`source-${index}`],
          terms: [`term-${index}`],
        }),
      );
    responses.push(textResponse("Emergency stop acknowledged."));
    const harness = createHarness(responses, { productiveVerification: true });
    const result = await run(
      harness,
      "Find an indefinitely expanding synthetic literature set",
      64,
    );
    expect(result.run.toolCallCount).toBe(64);
    expect(result.run.terminationReason).toBe("emergency-fuse");
  });

  it("H: repairs and stops identical no-progress calls before the fuse", async () => {
    const repeated = toolResponse("verify", "verify_candidates", {
      sourceIDs: ["source-1"],
      terms: ["same term"],
    });
    const responses = [
      toolResponse("plan", "plan_search", planArgs()),
      repeated,
      { ...repeated, toolCalls: [{ ...repeated.toolCalls[0], id: "verify-2" }] },
      { ...repeated, toolCalls: [{ ...repeated.toolCalls[0], id: "verify-3" }] },
      { ...repeated, toolCalls: [{ ...repeated.toolCalls[0], id: "verify-4" }] },
      textResponse("Stopped after no progress."),
    ];
    const harness = createHarness(responses);
    const result = await run(harness, "Find a paper with repeated verification", 80);
    expect(result.run.toolCallCount).toBeLessThan(10);
    expect(result.run.terminationReason).toBe("no-progress-guard");
    expect(result.run.events.some((event) => /No-progress/i.test(event.summary))).toBe(
      true,
    );
  });

  it("I: never exposes Zotero mutation tools in search states", async () => {
    const harness = createHarness([
      toolResponse("plan", "plan_search", planArgs()),
      toolResponse("finish", "finish_answer", {
        answer: "Search complete.",
        sourceIDs: [],
        evidenceInsufficient: false,
      }),
    ]);
    await run(harness, "Find a relevant paper");
    expect(harness.exposedTools[0]).toEqual(["plan_search"]);
    expect(harness.exposedTools[1]).toEqual(
      expect.arrayContaining(["verify_candidates", "finish_answer"]),
    );
    expect(harness.exposedTools.flat()).not.toContain("propose_add_tags");
  });

  it("J: exposes only the requested mutation proposal and keeps approval pending", async () => {
    const harness = createHarness([
      toolResponse("write", "propose_add_tags", {
        target: { libraryID: 1, itemKey: "ITEM0001" },
        tags: ["review"],
        label: "Add review tag",
      }),
    ]);
    const result = await run(harness, "Add the tag review to the selected paper");
    expect(harness.exposedTools[0]).toEqual([
      "get_current_context",
      "propose_add_tags",
    ]);
    expect(result.run.status).toBe("waiting-approval");
    expect(result.pendingBatch?.status).toBe("pending");
  });

  it("K: keeps provider reasoning in diagnostics and out of the answer", async () => {
    const harness = createHarness([
      toolResponse("plan", "plan_search", planArgs(), "private planning trace"),
      toolResponse(
        "finish",
        "finish_answer",
        {
          answer: "Visible grounded answer.",
          sourceIDs: [],
          evidenceInsufficient: false,
        },
        "private synthesis trace",
      ),
    ]);
    const result = await run(harness, "Find a paper", 80, deepSeekProfile(), true);
    expect(result.answer).toBe("Visible grounded answer.");
    expect(result.answer).not.toContain("private planning trace");
    expect(
      result.run.events.some(
        (event) =>
          event.type === "provider-reasoning" &&
          event.reasoningContent === "private planning trace",
      ),
    ).toBe(true);
    expect(result.protocolHistory?.[0]).toMatchObject({
      role: "assistant",
      reasoningContent: "private planning trace",
    });
  });
});

function createHarness(
  responses: any[],
  options: { productiveVerification?: boolean } = {},
) {
  const exposedTools: string[][] = [];
  const provider = {
    complete: vi.fn(
      async (_profile: ModelProfile, _messages: unknown[], tools: any[]) => {
        exposedTools.push(tools.map((entry) => entry.function.name));
        return responses.shift() || textResponse("Synthetic provider exhausted.");
      },
    ),
  };
  let verificationIndex = 0;
  const tools = {
    clearSources: vi.fn(),
    searchLearningContext: () => "",
    definitions: () => definitions(),
    execute: vi.fn(async (call: ToolCall): Promise<ToolResult> => {
      if (call.name === "plan_search")
        return {
          toolCallID: call.id,
          name: call.name,
          ok: true,
          content: {
            items: [
              {
                item: { libraryID: 1, itemKey: "ITEM0001" },
                sourceID: "source-plan",
              },
            ],
          },
          summary: "Plan returned one candidate",
          resultCount: 1,
        };
      if (call.name === "verify_candidates") {
        const index = verificationIndex++;
        return {
          toolCallID: call.id,
          name: call.name,
          ok: true,
          content: { items: [] },
          summary: options.productiveVerification
            ? `New evidence ${index}`
            : "No new evidence",
          sources: options.productiveVerification
            ? [
                {
                  sourceID: `evidence-${index}`,
                  item: { libraryID: 1, itemKey: `ITEM${index}` },
                  label: `Evidence ${index}`,
                  snippet: `Snippet ${index}`,
                  field: "fulltext",
                },
              ]
            : [],
          resultCount: options.productiveVerification ? 1 : 0,
        };
      }
      if (call.name === "finish_answer")
        return {
          toolCallID: call.id,
          name: call.name,
          ok: true,
          content: { answer: (call.arguments as any).answer },
          summary: "Answer completed",
          sources: [],
        };
      if (call.name === "propose_add_tags") {
        const pendingBatch: PendingWriteBatch = {
          id: "batch-1",
          conversationID: "conversation-1",
          createdAt: new Date().toISOString(),
          proposals: [],
          status: "pending",
        };
        return {
          toolCallID: call.id,
          name: call.name,
          ok: true,
          content: { requiresApproval: true },
          summary: "Awaiting approval",
          pendingBatch,
        };
      }
      throw new Error(`Unexpected tool ${call.name}`);
    }),
  };
  return { provider, tools, exposedTools };
}

async function run(
  harness: ReturnType<typeof createHarness>,
  query: string,
  maxToolCalls = 80,
  profile = genericProfile(),
  developerDiagnostics = false,
) {
  return new AgentRunner(harness.provider as any, harness.tools as any).run(
    "conversation-1",
    [
      {
        id: "user-1",
        role: "user",
        displayText: query,
        createdAt: new Date().toISOString(),
      },
    ],
    {
      refs: {
        items: [],
        attachments: [],
        notes: [],
        annotations: [],
        collections: [],
      },
    },
    profile,
    "System prompt",
    { maxToolCalls, maxAttachments: 20, developerDiagnostics },
    {
      onRun: () => undefined,
      onAssistantDelta: () => undefined,
      onToolResult: () => undefined,
      onApproval: () => undefined,
    },
  );
}

function definitions(): any[] {
  return [
    "plan_search",
    "verify_candidates",
    "finish_answer",
    "get_current_context",
    "propose_create_note",
    "propose_add_tags",
    "propose_relate_items",
  ].map((name) => ({ type: "function", function: { name } }));
}

function toolResponse(
  id: string,
  name: string,
  argumentsValue: unknown,
  reasoningContent = "",
) {
  const toolCall = { id, name, arguments: argumentsValue };
  return {
    text: "",
    reasoningContent,
    toolCalls: [toolCall],
    assistantMessage: {
      role: "assistant" as const,
      content: "",
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      tool_calls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(argumentsValue) },
        },
      ],
    },
    protocol: "native-tools" as const,
  };
}

function textResponse(text: string) {
  return {
    text,
    reasoningContent: "",
    toolCalls: [],
    assistantMessage: { role: "assistant" as const, content: text },
    protocol: "native-tools" as const,
  };
}

function planArgs() {
  return {
    discipline: "synthetic",
    subfield: "harness tests",
    intent: "topic",
    concepts: [
      {
        label: "concept",
        meaning: "synthetic concept",
        role: "required",
        variants: [
          {
            term: "synthetic concept",
            relation: "canonical",
            confidence: "high",
            origin: "model_inferred",
          },
        ],
      },
    ],
    exactTitles: [],
    englishQueries: ["synthetic concept"],
    searchCombinations: [
      "synthetic concept",
      "synthetic concept study",
      "synthetic concept evidence",
    ],
    excluded: [],
    rationale: "synthetic plan",
  };
}

function genericProfile(): ModelProfile {
  return {
    id: "generic",
    displayName: "Generic",
    baseURL: "https://generic.example/v1",
    apiKey: "",
    model: "generic",
    protocol: "native-tools",
    streaming: false,
    reasoningEnabled: false,
    reasoningEffort: "medium",
    timeoutMs: 5000,
    contextBudgetChars: 100000,
    evidenceBudgetChars: 60000,
  };
}

function deepSeekProfile(): ModelProfile {
  return {
    ...genericProfile(),
    id: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    reasoningEnabled: true,
    reasoningEffort: "max",
  };
}

it("keeps actionable answer recovery and the current reading tools visible", async () => {
  const harness = createHarness(
    [
      toolResponse("plan", "plan_search", planArgs()),
      toolResponse("bad", "finish_answer", {
        answer: "Unverified",
        sourceIDs: ["source-plan"],
        evidenceInsufficient: false,
      }),
      toolResponse("read", "verify_candidates", { sourceIDs: ["source-plan"] }),
      toolResponse("good", "finish_answer", {
        answer: "Qualified answer",
        sourceIDs: [],
        evidenceInsufficient: true,
      }),
    ],
    { productiveVerification: true },
  );
  const execute = harness.tools.execute.getMockImplementation()!;
  harness.tools.execute.mockImplementation(async (call) =>
    call.id === "bad"
      ? {
          toolCallID: call.id,
          name: call.name,
          ok: false,
          summary: "Answer needs evidence/qualification repair",
          content: {
            error: "Missing passage",
            recovery: {
              kind: "read-evidence",
              requiredActions: [
                {
                  tool: "verify_candidates",
                  arguments: { sourceIDs: ["source-plan"] },
                },
              ],
              instruction: "Read missing passage",
            },
          },
        }
      : execute(call),
  );
  const result = await run(harness, "Find and verify the requested method");
  expect(result.run.status).toBe("completed");
  expect(result.answer).toBe("Qualified answer");
  const request = harness.provider.complete.mock.calls[2];
  expect(JSON.stringify(request[1])).toContain("Current available tools:");
  expect(JSON.stringify(request[1])).toContain("Read missing passage");
  expect(harness.exposedTools[2]).toContain("verify_candidates");
  expect(harness.exposedTools.flat()).not.toContain("propose_add_tags");
});
