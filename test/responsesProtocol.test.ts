import { afterEach, expect, it, vi } from "vitest";
import { normalizeModelProfile } from "../src/utils/prefs";
import {
  OpenAICompatibleProvider,
  type ProviderMessage,
} from "../src/agent/modelProvider";
import { fitProviderMessages } from "../src/agent/agentRunner";
import { resolveAPIStyle } from "../src/agent/providerPresets";
import { probeProviderCapabilities } from "../src/agent/providerProbe";

const profile = (extra: object = {}) =>
  normalizeModelProfile({
    id: "openai",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-5.4",
    reasoningEnabled: true,
    reasoningEffort: "high",
    streaming: false,
    protocol: "native-tools",
    ...extra,
  })!;
const tools = [
  {
    type: "function",
    function: {
      name: "diagnostic_echo",
      description: "Echo",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
  },
];
const outputText = (text = "OK") => ({
  type: "message",
  role: "assistant",
  id: "message",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const outputCall = {
  type: "function_call",
  id: "function-item",
  call_id: "call-1",
  name: "diagnostic_echo",
  arguments: '{"value":"probe"}',
  status: "completed",
};
const reasoning = {
  type: "reasoning",
  id: "reasoning-item",
  encrypted_content: "synthetic-opaque-state",
  summary: [],
};
const payload = (output: any[]) => ({
  status: "completed",
  output,
  usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
});
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "round trips reasoning and function items using Responses streaming=%s",
  async (streaming) => {
    const requests: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        const data = payload(
          requests.length === 1 ? [reasoning, outputCall] : [outputText()],
        );
        if (!streaming) return new Response(JSON.stringify(data));
        const events =
          requests.length === 2
            ? ['data: {"type":"response.output_text.delta","delta":"OK"}\r\n\r\n']
            : [];
        events.push(
          "event: response.completed\r\ndata: " +
            JSON.stringify({ type: "response.completed", response: data }),
        );
        const encoded = new TextEncoder().encode(events.join(""));
        return new Response(
          new ReadableStream({
            start(controller) {
              for (let n = 0; n < encoded.length; n += 7)
                controller.enqueue(encoded.slice(n, n + 7));
              controller.close();
            },
          }),
        );
      }),
    );
    const provider = new OpenAICompatibleProvider();
    const p = profile({ streaming });
    const messages: ProviderMessage[] = [{ role: "user", content: "Use echo" }];
    const first = await provider.complete(
      p,
      messages,
      tools,
      new AbortController().signal,
    );
    messages.push(
      { ...first.assistantMessage, protocolRequired: true },
      {
        role: "tool",
        tool_call_id: "call-1",
        content: "probe",
        protocolRequired: true,
      },
    );
    const fitted = fitProviderMessages(messages, 10000);
    expect(() => fitProviderMessages(messages, 20)).toThrow(
      "configured context budget",
    );
    let delta = "";
    const final = await provider.complete(
      p,
      fitted,
      tools,
      new AbortController().signal,
      (part) => {
        delta += part;
      },
    );
    expect(final.text).toBe("OK");
    expect(final.usage).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    });
    if (streaming) expect(delta).toBe("OK");
    expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0].body).toMatchObject({
      store: false,
      reasoning: { effort: "high" },
    });
    expect(requests[0].body.tools[0]).toMatchObject({
      type: "function",
      name: "diagnostic_echo",
      strict: false,
    });
    expect(requests[1].body.input).toContainEqual(reasoning);
    expect(requests[1].body.input).toContainEqual(outputCall);
    expect(requests[1].body.input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "probe",
    });
    expect(requests[1].body).not.toHaveProperty("messages");
    expect(requests[1].body).not.toHaveProperty("thinking");
  },
);
it("selects Responses for OpenAI reasoning models and honors an explicit API choice", () => {
  for (const model of ["gpt-5", "gpt-5.4", "gpt-6.1-sol", "o3-mini"])
    expect(resolveAPIStyle(profile({ model }))).toBe("responses");
  expect(resolveAPIStyle(profile({ model: "gpt-4.1-mini" }))).toBe("chat-completions");
  expect(resolveAPIStyle(profile({ apiStyle: "chat-completions" }))).toBe(
    "chat-completions",
  );
  expect(
    resolveAPIStyle(profile({ baseURL: "https://api.openai.com.evil.test/v1" })),
  ).toBe("chat-completions");
});
it("never accepts a truncated Responses stream as a completed answer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        ),
    ),
  );
  await expect(
    new OpenAICompatibleProvider().complete(
      profile({ streaming: true }),
      [],
      tools,
      new AbortController().signal,
    ),
  ).rejects.toThrow("before completion");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("does not classify an unsupported reasoning parameter as unsupported tools", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "Unsupported parameter: reasoning_effort" },
          }),
          { status: 400 },
        ),
    ),
  );
  await expect(
    new OpenAICompatibleProvider().complete(
      profile({ protocol: "auto" }),
      [],
      tools,
      new AbortController().signal,
    ),
  ).rejects.toThrow("reasoning_effort");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("uses completion token limits for explicitly selected OpenAI chat reasoning", async () => {
  let body: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
      );
    }),
  );
  await new OpenAICompatibleProvider().complete(
    profile({ apiStyle: "chat-completions" }),
    [],
    [],
    new AbortController().signal,
    undefined,
    { maxTokens: 256 },
  );
  expect(body.max_completion_tokens).toBe(256);
  expect(body).not.toHaveProperty("max_tokens");
});
it("tests OpenAI reasoning without requiring a visible chain of thought", async () => {
  let count = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            payload(++count === 3 ? [reasoning, outputCall] : [outputText()]),
          ),
        ),
    ),
  );
  expect(
    (await probeProviderCapabilities(profile())).map((check) => check.status),
  ).toEqual(["PASS", "PASS", "PASS", "PASS"]);
});
it("keeps explicit JSON action results as plain input instead of orphan function outputs", async () => {
  const requests: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify(payload([outputText('{"type":"assistant","content":"OK"}')])),
      );
    }),
  );
  const result = await new OpenAICompatibleProvider().complete(
    profile({ protocol: "json-actions" }),
    [{ role: "tool", content: "result", tool_call_id: "json-call" }],
    tools,
    new AbortController().signal,
  );
  expect(result.text).toBe("OK");
  expect(requests[0].input.at(-1)).toEqual({
    role: "user",
    content: "Tool result json-call: result",
  });
});
