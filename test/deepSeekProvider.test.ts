import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelProfile } from "../src/core/types";
import { OpenAICompatibleProvider, ProviderMessage } from "../src/agent/modelProvider";
import { resolveProviderCapabilities } from "../src/agent/providerCapabilities";
import { buildProviderMessages, fitProviderMessages } from "../src/agent/agentRunner";

describe("official DeepSeek V4 protocol", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("A: sends an explicit disabled thinking mode and keeps non-thinking tools", async () => {
    const bodies: any[] = [];
    mockJSONFetch(bodies, [toolResponse("call-1", "diagnostic_echo", "")]);
    const response = await complete(deepSeekProfile(false), [], toolDefinitions());
    expect(bodies[0].thinking).toEqual({ type: "disabled" });
    expect(bodies[0].tool_choice).toBe("auto");
    expect(response.toolCalls[0].name).toBe("diagnostic_echo");
  });

  it("B: separates non-streaming reasoning_content from visible content", async () => {
    const bodies: any[] = [];
    mockJSONFetch(bodies, [textResponse("visible answer", "private reasoning")]);
    const response = await complete(
      deepSeekProfile(true),
      [],
      [],
      [{ role: "user", content: "answer" }],
    );
    expect(response.text).toBe("visible answer");
    expect(response.reasoningContent).toBe("private reasoning");
    expect(response.assistantMessage.reasoning_content).toBe("private reasoning");
    expect(bodies[0].thinking).toEqual({ type: "enabled" });
    expect(bodies[0].reasoning_effort).toBe("max");
  });

  it("C: echoes complete reasoning_content after a thinking tool call", async () => {
    const bodies: any[] = [];
    mockJSONFetch(bodies, [
      toolResponse("call-1", "diagnostic_echo", "reasoning one"),
      textResponse("done", "reasoning two"),
    ]);
    const profile = deepSeekProfile(true);
    const provider = new OpenAICompatibleProvider();
    const messages: ProviderMessage[] = [{ role: "user", content: "use the tool" }];
    const first = await provider.complete(
      profile,
      messages,
      toolDefinitions(),
      new AbortController().signal,
      undefined,
      { stage: "tool-routing" },
    );
    messages.push(first.assistantMessage, {
      role: "tool",
      tool_call_id: "call-1",
      content: '{"echoed":true}',
    });
    await provider.complete(
      profile,
      messages,
      toolDefinitions(),
      new AbortController().signal,
      undefined,
      { stage: "final-synthesis" },
    );
    const echoed = bodies[1].messages.find(
      (message: any) => message.role === "assistant" && message.tool_calls,
    );
    expect(echoed).toMatchObject({
      content: "",
      reasoning_content: "reasoning one",
    });
    expect(bodies[1]).not.toHaveProperty("tool_choice");
  });

  it("D: retains every reasoning/tool message across multiple rounds", async () => {
    const bodies: any[] = [];
    mockJSONFetch(bodies, [
      toolResponse("call-1", "diagnostic_echo", "reasoning one"),
      toolResponse("call-2", "diagnostic_echo", "reasoning two"),
      textResponse("done", "reasoning three"),
    ]);
    const provider = new OpenAICompatibleProvider();
    const profile = deepSeekProfile(true);
    const messages: ProviderMessage[] = [{ role: "user", content: "two tools" }];
    for (const callID of ["call-1", "call-2"]) {
      const response = await provider.complete(
        profile,
        messages,
        toolDefinitions(),
        new AbortController().signal,
        undefined,
        { stage: "tool-routing" },
      );
      messages.push(response.assistantMessage, {
        role: "tool",
        tool_call_id: callID,
        content: `{"result":"${callID}"}`,
      });
    }
    await provider.complete(
      profile,
      messages,
      toolDefinitions(),
      new AbortController().signal,
      undefined,
      { stage: "final-synthesis" },
    );
    const retained = bodies[2].messages.filter(
      (message: any) => message.role === "assistant" && message.tool_calls,
    );
    expect(retained.map((message: any) => message.reasoning_content)).toEqual([
      "reasoning one",
      "reasoning two",
    ]);
  });

  it("keeps completed answers but does not replay completed tool history into a later user turn", () => {
    const messages = buildProviderMessages(
      [
        {
          id: "user-1",
          role: "user",
          displayText: "First request",
          createdAt: new Date().toISOString(),
        },
        {
          id: "assistant-1",
          role: "assistant",
          displayText: "First visible answer",
          createdAt: new Date().toISOString(),
          protocolHistory: [
            {
              role: "assistant",
              content: "",
              reasoningContent: "required prior reasoning",
              toolCalls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "diagnostic_echo", arguments: "{}" },
                },
              ],
            },
            {
              role: "tool",
              toolCallID: "call-1",
              content: '{"ok":true}',
            },
          ],
        },
        {
          id: "user-2",
          role: "user",
          displayText: "Follow-up request",
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
      "System",
      "",
      true,
    );
    const fitted = fitProviderMessages(messages, 20_000);
    expect(fitted.some((message) => message.reasoning_content)).toBe(false);
    expect(fitted.some((message) => message.tool_call_id === "call-1")).toBe(false);
    expect(fitted.some((message) => message.content === "First visible answer")).toBe(
      true,
    );
    expect(fitted.at(-1)?.content).toContain("Follow-up request");
  });

  it("E: accumulates streamed reasoning separately from content", async () => {
    const chunks = [
      sse({ choices: [{ delta: { reasoning_content: "reason " } }] }),
      sse({ choices: [{ delta: { reasoning_content: "trace" } }] }),
      sse({ choices: [{ delta: { content: "visible" } }] }),
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(chunks)),
    );
    let reasoningDelta = "";
    const response = await new OpenAICompatibleProvider().complete(
      { ...deepSeekProfile(true), streaming: true },
      [{ role: "user", content: "stream" }],
      [],
      new AbortController().signal,
      undefined,
      {
        stage: "final-synthesis",
        onReasoningDelta: (delta) => (reasoningDelta += delta),
      },
    );
    expect(reasoningDelta).toBe("reason trace");
    expect(response.reasoningContent).toBe("reason trace");
    expect(response.text).toBe("visible");
  });

  it("F: preserves the required function type in streamed tool history", async () => {
    const chunks = [
      sse({
        choices: [
          {
            delta: {
              reasoning_content: "plan",
              tool_calls: [
                {
                  index: 0,
                  id: "call-stream",
                  type: "function",
                  function: {
                    name: "diagnostic_echo",
                    arguments: '{"value":"probe"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(chunks)),
    );
    const response = await new OpenAICompatibleProvider().complete(
      { ...deepSeekProfile(true), streaming: true },
      [{ role: "user", content: "stream a tool" }],
      toolDefinitions(),
      new AbortController().signal,
      undefined,
      { stage: "tool-routing" },
    );
    expect(response.assistantMessage.tool_calls?.[0]).toMatchObject({
      id: "call-stream",
      type: "function",
      function: { name: "diagnostic_echo" },
    });
  });

  it("G: consumes the final SSE event even when the stream closes without a separator", async () => {
    const finalEvent = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-tail",
                type: "function",
                function: {
                  name: "diagnostic_echo",
                  arguments: '{"value":"tail"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse([finalEvent])),
    );

    const response = await new OpenAICompatibleProvider().complete(
      { ...deepSeekProfile(true), streaming: true },
      [{ role: "user", content: "stream a final tool event" }],
      toolDefinitions(),
      new AbortController().signal,
    );

    expect(response.toolCalls[0]).toMatchObject({
      id: "call-tail",
      name: "diagnostic_echo",
      arguments: { value: "tail" },
    });
  });

  it("H: retries malformed streamed tool arguments once as strict non-streaming JSON", async () => {
    const bodies: any[] = [];
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        requestCount++;
        if (requestCount === 1)
          return streamResponse([
            sse({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-broken",
                        type: "function",
                        function: {
                          name: "diagnostic_echo",
                          arguments: '{"value":"broken"',
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          ]);
        return new Response(
          JSON.stringify(toolResponse("call-repaired", "diagnostic_echo", "repaired")),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const response = await new OpenAICompatibleProvider().complete(
      { ...deepSeekProfile(true), streaming: true },
      [{ role: "user", content: "repair a malformed tool call" }],
      toolDefinitions(),
      new AbortController().signal,
    );

    expect(response.toolCalls[0].id).toBe("call-repaired");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].stream).toBe(true);
    expect(bodies[1].stream).toBe(false);
    expect(bodies[1].messages.at(-1).content).toContain(
      "complete, strictly valid JSON",
    );
  });

  it("L: keeps generic native tools without assuming vendor reasoning parameters", async () => {
    const bodies: any[] = [];
    mockJSONFetch(bodies, [textResponse("generic", "")]);
    const profile = {
      ...deepSeekProfile(true),
      baseURL: "https://generic.example/v1",
      model: "generic-reasoning-model",
      reasoningEffort: "medium" as const,
    };
    await complete(profile, [], toolDefinitions());
    expect(resolveProviderCapabilities(profile).id).toBe("generic-openai-compatible");
    expect(bodies[0].tool_choice).toBe("auto");
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(bodies[0]).not.toHaveProperty("enable_thinking");
  });
});

async function complete(
  profile: ModelProfile,
  bodies: any[],
  tools: any[],
  messages: ProviderMessage[] = [{ role: "user", content: "test" }],
) {
  void bodies;
  return new OpenAICompatibleProvider().complete(
    profile,
    messages,
    tools,
    new AbortController().signal,
    undefined,
    { stage: "final-synthesis" },
  );
}

function deepSeekProfile(reasoningEnabled: boolean): ModelProfile {
  return {
    id: "deepseek-v4",
    displayName: "DeepSeek V4 Flash",
    baseURL: "https://api.deepseek.com",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    protocol: "native-tools",
    streaming: false,
    reasoningEnabled,
    reasoningEffort: "max",
    timeoutMs: 5000,
    contextBudgetChars: 100000,
    evidenceBudgetChars: 60000,
  };
}

function toolDefinitions(): any[] {
  return [
    {
      type: "function",
      function: {
        name: "diagnostic_echo",
        description: "Echo a value",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    },
  ];
}

function toolResponse(id: string, name: string, reasoning: string): any {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          reasoning_content: reasoning,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: '{"value":"probe"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function textResponse(content: string, reasoning: string): any {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          reasoning_content: reasoning,
        },
        finish_reason: "stop",
      },
    ],
  };
}

function mockJSONFetch(bodies: any[], responses: any[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}
