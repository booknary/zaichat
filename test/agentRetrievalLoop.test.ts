import { describe, expect, it } from "vitest";
import {
  AgentRunner,
  filterToolDefinitions,
  augmentSearchPlan,
  extractTitleCandidates,
  selectAnswerSources,
} from "../src/agent/agentRunner";
import type { ModelProfile, ToolCall, ToolResult } from "../src/core/types";

describe("AI-directed retrieval loop", () => {
  it("allows a corrected finish after two citation failures", async () => {
    const calls: ToolCall[] = [];
    const tools = fakeTools(calls);
    const execute = tools.execute;
    let attempts = 0;
    tools.execute = async (call: ToolCall) => {
      if (call.name === "finish_answer" && ++attempts <= 2) {
        calls.push(call);
        return {
          toolCallID: call.id,
          name: call.name,
          ok: false,
          content: { error: "Use contextual source IDs" },
          summary: "Citation repair",
        };
      }
      return execute(call);
    };
    const output = await runWithResponses(
      [
        planResponse("plan"),
        toolResponse("verify", "get_items", {
          refs: [{ libraryID: 1, itemKey: "TARGET01" }],
        }),
        finishResponse("bad1", "Unsupported first claim"),
        finishResponse("bad2", "Unsupported second claim"),
        finishResponse("fixed", "Verified answer [source-1]"),
      ],
      tools,
    );
    expect(attempts).toBe(3);
    expect(output.run.status).toBe("completed");
    expect(output.answer).toContain("Verified answer");
  });

  it("requires finalization even when no finish validation has failed yet", async () => {
    const output = await runWithResponses(
      [
        planResponse("plan"),
        {
          text: "Unsupported document conclusion",
          toolCalls: [],
          protocol: "native-tools" as const,
        },
        {
          text: "Unsupported document conclusion",
          toolCalls: [],
          protocol: "native-tools" as const,
        },
        {
          text: "Unsupported document conclusion",
          toolCalls: [],
          protocol: "native-tools" as const,
        },
      ],
      fakeTools([]),
    );
    expect(output.run.status).toBe("failed");
  });

  it("does not accept plain text as a bypass after failed finish validation", async () => {
    const tools = fakeTools([]);
    const execute = tools.execute;
    tools.execute = async (call: ToolCall) =>
      call.name === "finish_answer"
        ? {
            toolCallID: call.id,
            name: call.name,
            ok: false,
            content: { error: "Missing evidence" },
            summary: "Citation repair",
          }
        : execute(call);
    const output = await runWithResponses(
      [
        planResponse("plan"),
        toolResponse("verify", "get_items", {
          refs: [{ libraryID: 1, itemKey: "TARGET01" }],
        }),
        finishResponse("bad", "Unsupported claim"),
        ...Array.from({ length: 3 }, () => ({ text: "Bypassed claim", toolCalls: [] })),
      ],
      tools,
    );
    expect(output.run.status).toBe("failed");
    expect(output.answer).not.toContain("Bypassed claim");
    expect(output.sources).toEqual([]);
  });

  it("hides note, annotation, and collection tools unless the user asks for them", () => {
    const definitions = [
      "plan_search",
      "list_item_notes",
      "list_item_annotations",
      "list_collections",
    ].map((name) => ({ function: { name } }));
    expect(
      filterToolDefinitions(definitions, "find a paper").map(
        (entry) => entry.function.name,
      ),
    ).toEqual(["plan_search"]);
    expect(
      filterToolDefinitions(definitions, "search my notes and annotations").map(
        (entry) => entry.function.name,
      ),
    ).toEqual(["plan_search", "list_item_notes", "list_item_annotations"]);
  });
  it("extracts and injects a supplied English title before model-directed search", () => {
    const title =
      "The origin of land plants is rooted in two bursts of genomic novelty";
    expect(extractTitleCandidates(`这篇文章标题是：\n${title}`)).toEqual([title]);
    expect(extractTitleCandidates(`标题是：${title}`)).toEqual([title]);
    expect(
      (
        augmentSearchPlan(
          { id: "plan", name: "plan_search", arguments: { exactTitles: [] } },
          title,
        ).arguments as any
      ).exactTitles,
    ).toContain(title);
  });

  it("limits final source cards and deduplicates snippets from the same item", () => {
    const sources = Array.from({ length: 12 }, (_, index) => ({
      sourceID: `source-${index}`,
      item: { libraryID: 1, itemKey: `ITEM${Math.floor(index / 2)}` },
      label: `Paper ${index}`,
    }));
    const selected = selectAnswerSources("Uses source-10", sources);
    expect(selected).toHaveLength(6);
    expect(selected[0].sourceID).toBe("source-10");
    expect(new Set(selected.map((source) => source.item.itemKey)).size).toBe(6);
  });

  it("runs AI plan with automatic recall, review, explicit verification, and finish", async () => {
    const calls: ToolCall[] = [];
    const responses = [
      planResponse("plan-1"),
      toolResponse("verify-1", "get_items", {
        refs: [{ libraryID: 1, itemKey: "TARGET01" }],
      }),
      finishResponse("finish-1", "Verified answer [source-1]"),
    ];
    const result = await runWithResponses(responses, fakeTools(calls));
    expect(calls.map((call) => call.name)).toEqual([
      "plan_search",
      "get_items",
      "finish_answer",
    ]);
    expect(result.answer).toContain("Verified answer");
  });

  it("lets AI inspect weak candidates and replace the plan before verification", async () => {
    const calls: ToolCall[] = [];
    const responses = [
      planResponse("plan-1"),
      planResponse("plan-2", true),
      toolResponse("verify-2", "get_items", {
        refs: [{ libraryID: 1, itemKey: "TARGET02" }],
      }),
      finishResponse("finish-2", "The revised plan found a verified match [source-1]"),
    ];
    const result = await runWithResponses(responses, fakeTools(calls));
    expect(calls.map((call) => call.name)).toEqual([
      "plan_search",
      "plan_search",
      "get_items",
      "finish_answer",
    ]);
    expect(result.answer).toContain("revised plan");
  });

  it("prompts AI to revise one empty plan before accepting insufficiency", async () => {
    const calls: ToolCall[] = [];
    const responses = [
      planResponse("plan-1"),
      { text: "Nothing found.", toolCalls: [], protocol: "native-tools" as const },
      planResponse("plan-2", true),
      finishResponse("finish-2", "No verified result after two plans.", true),
    ];
    const result = await runWithResponses(
      responses,
      fakeTools(calls, { emptyPlans: new Set([1, 2]) }),
    );
    expect(calls.filter((call) => call.name === "plan_search")).toHaveLength(2);
    expect(result.answer).toContain("No verified result");
  });

  it("limits an automatic no-result conclusion to the searched Zotero library", async () => {
    const calls: ToolCall[] = [];
    const noTools = {
      text: "",
      toolCalls: [],
      protocol: "native-tools" as const,
    };
    const result = await runWithResponses(
      [planResponse("plan-1"), noTools, planResponse("plan-2", true), noTools, noTools],
      fakeTools(calls, { emptyPlans: new Set([1, 2]) }),
    );
    expect(result.answer).toContain("My Library");
    expect(result.answer).toContain("does not show");
  });

  it("rejects an unexplained repeated planning loop", async () => {
    const repeated = planResponse("plan-1");
    const responses = [
      repeated,
      { ...repeated, toolCalls: [{ ...repeated.toolCalls[0], id: "plan-2" }] },
      { ...repeated, toolCalls: [{ ...repeated.toolCalls[0], id: "plan-3" }] },
      {
        text: "Stopped duplicate planning.",
        toolCalls: [],
        protocol: "native-tools" as const,
      },
    ];
    const calls: ToolCall[] = [];
    const result = await runWithResponses(responses, fakeTools(calls));
    expect(calls).toHaveLength(1);
    expect(result.answer).toContain("Stopped duplicate planning");
  });

  it("reviews each new candidate set before executing batched follow-up tools", async () => {
    const calls: ToolCall[] = [];
    const responses = [
      {
        text: "",
        toolCalls: [
          planResponse("plan-1").toolCalls[0],
          toolResponse("verify-stale", "get_items", {
            refs: [{ libraryID: 1, itemKey: "STALE001" }],
          }).toolCalls[0],
        ],
        protocol: "native-tools" as const,
      },
      toolResponse("verify-current", "get_items", {
        refs: [{ libraryID: 1, itemKey: "TARGET01" }],
      }),
      finishResponse("finish-1", "Reviewed current results [source-1]"),
    ];
    const result = await runWithResponses(responses, fakeTools(calls));
    expect(calls.map((call) => call.id)).toEqual([
      "plan-1",
      "verify-current",
      "finish-1",
    ]);
    expect(result.answer).toContain("Reviewed current results");
  });

  it("disables a tool after two failures even when its arguments change", async () => {
    const calls: ToolCall[] = [];
    const tools = {
      clearSources: () => undefined,
      definitions: () => [{ type: "function", function: { name: "plan_search" } }],
      execute: async (call: ToolCall): Promise<ToolResult> => {
        calls.push(call);
        if (call.name === "plan_search") {
          return {
            toolCallID: call.id,
            name: call.name,
            ok: true,
            content: { items: [{ item: { libraryID: 1, itemKey: "TARGET01" } }] },
            summary: "Found one candidate",
            resultCount: 1,
          };
        }
        return {
          toolCallID: call.id,
          name: call.name,
          ok: false,
          content: { error: "Zotero API failure" },
          summary: `Tool ${call.name} failed: Zotero API failure`,
        };
      },
    };
    const responses = [
      planResponse("plan-1"),
      toolResponse("snippet-1", "read_attachment_snippets", {
        attachments: [{ libraryID: 1, itemKey: "ATTACH01" }],
        terms: ["one"],
      }),
      toolResponse("snippet-2", "read_attachment_snippets", {
        attachments: [{ libraryID: 1, itemKey: "ATTACH02" }],
        terms: ["two"],
      }),
      toolResponse("snippet-3", "read_attachment_snippets", {
        attachments: [{ libraryID: 1, itemKey: "ATTACH03" }],
        terms: ["three"],
      }),
      {
        text: "No verified result after the local tool failed.",
        toolCalls: [],
        protocol: "native-tools" as const,
      },
    ];
    const result = await runWithResponses(responses, tools as any);
    expect(
      calls.filter((call) => call.name === "read_attachment_snippets"),
    ).toHaveLength(2);
    expect(result.answer).toContain("No verified result");
  });

  it("stops revising after the second bounded search plan", async () => {
    const calls: ToolCall[] = [];
    const responses = [
      planResponse("plan-1"),
      planResponse("plan-2", true),
      planResponse("plan-3", true),
      {
        text: "Two bounded strategies were inconclusive.",
        toolCalls: [],
        protocol: "native-tools" as const,
      },
    ];
    const result = await runWithResponses(responses, fakeTools(calls));
    expect(calls.filter((call) => call.name === "plan_search")).toHaveLength(2);
    expect(result.run.status).toBe("completed");
    expect(result.answer).toContain("inconclusive");
  });

  it("keeps verified evidence while allowing one diagnostic plan revision", async () => {
    const calls: ToolCall[] = [];
    const responses = [
      planResponse("plan-1"),
      toolResponse("verify-1", "get_items", {
        refs: [{ libraryID: 1, itemKey: "TARGET01" }],
      }),
      planResponse("plan-2", true),
      {
        text: "Answer from preserved verified evidence.",
        toolCalls: [],
        protocol: "native-tools" as const,
      },
    ];
    const result = await runWithResponses(responses, fakeTools(calls));
    expect(calls.map((call) => call.name)).toEqual([
      "plan_search",
      "get_items",
      "plan_search",
    ]);
    expect(result.sources).toHaveLength(1);
    expect(result.answer).toContain("preserved verified evidence");
  });
});

function fakeTools(calls: ToolCall[], options: { emptyPlans?: Set<number> } = {}) {
  let planCount = 0;
  return {
    clearSources: () => undefined,
    definitions: () => [{ type: "function", function: { name: "plan_search" } }],
    execute: async (call: ToolCall): Promise<ToolResult> => {
      calls.push(call);
      if (call.name === "plan_search") {
        planCount++;
        const empty = options.emptyPlans?.has(planCount) || false;
        return {
          toolCallID: call.id,
          name: call.name,
          ok: true,
          planID: `PLAN${planCount}`,
          content: {
            plan: { id: `PLAN${planCount}` },
            items: empty
              ? []
              : [{ item: { libraryID: 1, itemKey: `TARGET0${planCount}` } }],
          },
          summary: `${planCount === 1 ? "Created" : "Revised"} plan; found ${empty ? 0 : 1} candidates`,
          resultCount: empty ? 0 : 1,
        };
      }
      if (call.name === "get_items")
        return {
          toolCallID: call.id,
          name: call.name,
          ok: true,
          content: { items: [{ item: { libraryID: 1, itemKey: "TARGET01" } }] },
          summary: "Verified selected metadata",
          sources: [
            {
              sourceID: "source-1",
              item: { libraryID: 1, itemKey: "TARGET01" },
              label: "Selected paper",
            },
          ],
        };
      if (call.name === "finish_answer")
        return {
          toolCallID: call.id,
          name: call.name,
          ok: true,
          content: { answer: String((call.arguments as any).answer) },
          summary: "Answer finished",
          sources: (call.arguments as any).sourceIDs.length
            ? [
                {
                  sourceID: "source-1",
                  item: { libraryID: 1, itemKey: "TARGET01" },
                  label: "Selected paper",
                },
              ]
            : [],
        };
      throw new Error(`Unexpected tool ${call.name}`);
    },
  };
}

async function runWithResponses(responses: any[], tools: any) {
  const runner = new AgentRunner(
    { complete: async () => responses.shift() } as any,
    tools,
  );
  return runner.run(
    "conversation-1",
    [
      {
        id: "message-1",
        role: "user",
        displayText: "Find a paper",
        createdAt: new Date().toISOString(),
      },
    ],
    {
      refs: { items: [], attachments: [], notes: [], annotations: [], collections: [] },
    },
    profile(),
    "You are a literature assistant.",
    { maxToolCalls: 10, maxAttachments: 20 },
    {
      onRun: () => undefined,
      onAssistantDelta: () => undefined,
      onToolResult: () => undefined,
      onApproval: () => undefined,
    },
  );
}

function planResponse(id: string, revised = false) {
  return toolResponse(id, "plan_search", {
    exactTitles: [],
    englishQueries: ["concept a concept b", "concept a synonym b"],
    searchCombinations: [
      "concept a concept b",
      "synonym a concept b",
      "concept a synonym b",
    ],
    required: [
      ["concept-a", "synonym-a"],
      ["concept-b", "synonym-b"],
    ],
    optional: [],
    excluded: [],
    rationale: "Split independent concepts and add synonyms",
    ...(revised ? { revisionReason: "Previous candidates missed a core concept" } : {}),
  });
}

function finishResponse(id: string, answer: string, insufficient = false) {
  return toolResponse(id, "finish_answer", {
    answer,
    sourceIDs: insufficient ? [] : ["source-1"],
    evidenceInsufficient: insufficient,
  });
}

function toolResponse(id: string, name: string, args: unknown) {
  return {
    text: "",
    toolCalls: [{ id, name, arguments: args }],
    protocol: "native-tools" as const,
  };
}

function profile(): ModelProfile {
  return {
    id: "profile-1",
    displayName: "Test",
    baseURL: "https://example.test/v1",
    apiKey: "",
    model: "test",
    protocol: "native-tools",
    streaming: false,
    reasoningEnabled: false,
    reasoningEffort: "medium",
    timeoutMs: 1000,
    contextBudgetChars: 100000,
    evidenceBudgetChars: 60000,
  };
}
