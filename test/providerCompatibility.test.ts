import { afterEach, expect, it, vi } from "vitest";
import { normalizeModelProfile } from "../src/utils/prefs";
import {
  resolveProviderCapabilities,
  isBailianEndpoint,
} from "../src/agent/providerCapabilities";
import { OpenAICompatibleProvider } from "../src/agent/modelProvider";
import { probeProviderCapabilities } from "../src/agent/providerProbe";

const profile = (extra: Record<string, unknown> = {}) =>
  normalizeModelProfile({
    id: "compat",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "deepseek-v4.1-flash-1017",
    apiKey: "test-only",
    protocol: "native-tools",
    streaming: false,
    reasoningEnabled: true,
    reasoningEffort: "medium",
    ...extra,
  })!;
const text = (reasoning = "") => ({ content: "OK", reasoning_content: reasoning });
const call = (reasoning = "") => ({
  content: "",
  reasoning_content: reasoning,
  tool_calls: [
    {
      id: "call-test",
      type: "function",
      function: { name: "diagnostic_echo", arguments: '{"value":"probe"}' },
    },
  ],
});
function mock(messages: object[]) {
  const bodies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const message = messages.shift();
      if (!message) throw new Error("Unexpected request");
      return body.stream
        ? new Response(
            "data: " +
              JSON.stringify({ choices: [{ delta: message }] }) +
              "\n\ndata: [DONE]\n\n",
          )
        : new Response(JSON.stringify({ choices: [{ message }] }));
    }),
  );
  return bodies;
}
afterEach(() => vi.unstubAllGlobals());

it.each(["deepseek-v4.1-flash-1017", "deepseek-v4-flash-0731", "deepseek-v4-pro"])(
  "uses Bailian's thinking switch and valid effort for %s",
  async (model) => {
    const bodies = mock([text("reason")]);
    await new OpenAICompatibleProvider().complete(
      profile({ model }),
      [],
      [],
      new AbortController().signal,
    );
    expect(bodies[0]).toMatchObject({
      enable_thinking: true,
      reasoning_effort: "high",
    });
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(bodies[0]).not.toHaveProperty("extra_body");
  },
);
it("sends an explicit Bailian disable without an unsupported effort", async () => {
  const bodies = mock([text()]);
  await new OpenAICompatibleProvider().complete(
    profile({ reasoningEnabled: false }),
    [],
    [],
    new AbortController().signal,
  );
  expect(bodies[0].enable_thinking).toBe(false);
  expect(bodies[0]).not.toHaveProperty("reasoning_effort");
});
it.each(["qwen-plus", "qwen3-32b", "qwen3.5-plus"])(
  "does not assume DeepSeek effort for %s",
  async (model) => {
    const bodies = mock([text("reason")]);
    await new OpenAICompatibleProvider().complete(
      profile({ model }),
      [],
      [],
      new AbortController().signal,
    );
    expect(bodies[0].enable_thinking).toBe(true);
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  },
);
it("does not infer capabilities from a model name on an unrelated host", async () => {
  const bodies = mock([text()]);
  await new OpenAICompatibleProvider().complete(
    profile({ baseURL: "https://example.test/v1" }),
    [],
    [],
    new AbortController().signal,
  );
  for (const key of ["thinking", "reasoning_effort", "enable_thinking"])
    expect(bodies[0]).not.toHaveProperty(key);
});
it("accepts official regional/workspace endpoints without suffix spoofing", () => {
  for (const host of [
    "dashscope.aliyuncs.com",
    "dashscope-intl.aliyuncs.com",
    "dashscope-us.aliyuncs.com",
    "demo.cn-beijing.maas.aliyuncs.com",
  ])
    expect(isBailianEndpoint("https://" + host + "/compatible-mode/v1")).toBe(true);
  for (const host of [
    "dashscope.aliyuncs.com.evil.test",
    "notmaas.aliyuncs.com",
    "evil-maas.aliyuncs.com",
  ])
    expect(isBailianEndpoint("https://" + host)).toBe(false);
});
it.each([
  "qwen3-coder-plus",
  "qwen3-235b-a22b-thinking-2507",
  "qwen3-embedding",
  "custom-deployment",
])("keeps defaults for unsupported or unknown switches on %s", (model) => {
  expect(resolveProviderCapabilities(profile({ model })).thinkingParameter).toBe(
    "default",
  );
});
it.each([
  ["thinking", "thinking"],
  ["enable-thinking", "enable_thinking"],
  ["reasoning-effort", "reasoning_effort"],
])(
  "honors an explicit %s override on a custom service",
  async (reasoningMode, field) => {
    const bodies = mock([text()]);
    await new OpenAICompatibleProvider().complete(
      profile({ baseURL: "https://example.test/v1", reasoningMode }),
      [],
      [],
      new AbortController().signal,
    );
    expect(bodies[0]).toHaveProperty(field);
    for (const key of ["thinking", "enable_thinking", "reasoning_effort"].filter(
      (key) => key !== field,
    ))
      expect(bodies[0]).not.toHaveProperty(key);
  },
);
it.each([false, true])(
  "tests generic tool round trips with streaming=%s and no vendor skip rows",
  async (streaming) => {
    const bodies = mock([text(), call(), text()]);
    const checks = await probeProviderCapabilities(
      profile({ baseURL: "https://example.test/v1", streaming }),
    );
    expect(checks).toEqual([
      { name: "API", status: "PASS" },
      { name: "Tool calls", status: "PASS" },
      { name: "Tool round-trip", status: "PASS" },
    ]);
    expect(bodies[2].messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-test",
    });
    expect(bodies.every((body) => body.stream === streaming)).toBe(true);
  },
);
it("probes thinking with tools and preserves empty reasoning in Bailian history", async () => {
  const bodies = mock([text(), text("reason"), call(""), text()]);
  const checks = await probeProviderCapabilities(profile());
  expect(checks.every((check) => check.status === "PASS")).toBe(true);
  expect(bodies[0].enable_thinking).toBe(false);
  expect(bodies[2].enable_thinking).toBe(true);
  expect(bodies[3].messages.find((m: any) => m.tool_calls)).toMatchObject({
    content: "",
    reasoning_content: "",
  });
});
it("does not report success after a bad tool call or run a fabricated tool result", async () => {
  const bodies = mock([text(), text()]);
  const checks = await probeProviderCapabilities(profile({ reasoningEnabled: false }));
  expect(checks.map((check) => check.status)).toEqual(["PASS", "FAIL", "SKIP"]);
  expect(bodies).toHaveLength(2);
});
it("does not let auto JSON fallback masquerade as native tool support", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ choices: [{ message: text() }] }))
        : new Response(
            JSON.stringify({ error: { message: "tools are not supported" } }),
            { status: 400 },
          );
    }),
  );
  const checks = await probeProviderCapabilities(
    profile({ protocol: "auto", reasoningEnabled: false }),
  );
  expect(checks[1].status).toBe("FAIL");
  expect(calls).toBe(2);
});

it("adapts Ark model IDs while keeping opaque deployment IDs configurable", async () => {
  const p = profile({
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-0-lite-260215",
    reasoningEffort: "medium",
  });
  const bodies = mock([text("reason")]);
  await new OpenAICompatibleProvider().complete(
    p,
    [],
    [],
    new AbortController().signal,
  );
  expect(bodies[0]).toMatchObject({
    thinking: { type: "enabled" },
    reasoning_effort: "medium",
  });
  expect(bodies[0]).not.toHaveProperty("enable_thinking");
  expect(
    resolveProviderCapabilities({ ...p, model: "ep-deployment" }).thinkingParameter,
  ).toBe("default");
  expect(
    resolveProviderCapabilities({
      ...p,
      model: "ep-deployment",
      reasoningMode: "thinking",
    }).thinkingParameter,
  ).toBe("thinking");
});
it("persists provider and API choices without changing existing retrieval budgets", () => {
  const p = profile({
    provider: "ark",
    apiStyle: "chat-completions",
    reasoningMode: "thinking",
    contextBudgetChars: 123456,
    evidenceBudgetChars: 54321,
  });
  expect(normalizeModelProfile(p)).toEqual(p);
  expect(p).toMatchObject({
    provider: "ark",
    apiStyle: "chat-completions",
    contextBudgetChars: 123456,
    evidenceBudgetChars: 54321,
  });
});
