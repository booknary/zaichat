import { afterEach, expect, it, vi } from "vitest";
import {
  normalizeModelProfile,
  writeModelProfiles,
  readModelProfiles,
} from "../src/utils/prefs";
import { fetchModelCatalog } from "../src/agent/modelCatalog";
import {
  resolveProviderCapabilities,
  stageModelOptions,
} from "../src/agent/providerCapabilities";
import { OpenAICompatibleProvider } from "../src/agent/modelProvider";
import { conversationUsage, parseTokenUsage } from "../src/agent/tokenUsage";

afterEach(() => vi.unstubAllGlobals());
const profile = () =>
  normalizeModelProfile({
    id: "test",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-flash",
    apiKey: " dummy-test-only ",
    reasoningEnabled: true,
    reasoningEffort: "low",
  })!;
it("round-trips edited model and key, rejecting invalid saves without dropping profiles", () => {
  const data = new Map<string, unknown>();
  vi.stubGlobal("Zotero", {
    Prefs: {
      get: (k: string) => data.get(k),
      set: (k: string, v: unknown) => data.set(k, v),
    },
  });
  writeModelProfiles([profile()]);
  expect(readModelProfiles()[0]).toMatchObject({
    model: "deepseek-flash",
    apiKey: "dummy-test-only",
  });
  const next = { ...profile(), model: "deepseek-pro", apiKey: "replacement-test-only" };
  writeModelProfiles([next]);
  expect(readModelProfiles()[0]).toEqual(next);
  expect(() => writeModelProfiles([{ ...next, model: "" }])).toThrow("未保存");
  expect(readModelProfiles()[0]).toEqual(next);
});
it("recognizes official aliases and respects selected effort in every stage", () => {
  expect(resolveProviderCapabilities(profile()).reasoningEffortValues).toEqual([
    "low",
    "high",
    "max",
  ]);
  for (const stage of ["search-planning", "final-synthesis"] as const)
    expect(stageModelOptions(profile(), stage).reasoningEffort).toBe("low");
});
it("loads and deduplicates provider IDs with redirect protection", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, { id: 9 }] }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(await fetchModelCatalog(profile().baseURL, profile().apiKey)).toEqual([
    "a",
    "b",
  ]);
  expect(fetcher.mock.calls[0][0]).toBe("https://api.deepseek.com/models");
  expect(fetcher.mock.calls[0][1].redirect).toBe("error");
});
it("does not expose provider errors or send credentials to unsafe addresses", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response("secret-provider-body", { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(fetchModelCatalog("http://example.com", "test")).rejects.toThrow(
    "HTTPS",
  );
  expect(fetcher).not.toHaveBeenCalled();
  await expect(fetchModelCatalog(profile().baseURL, "test")).rejects.toThrow(
    "HTTP 401",
  );
});
it("captures JSON and final SSE usage without double counting streaming chunks", async () => {
  for (const streaming of [false, true]) {
    const usage = { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 };
    const content = streaming
      ? `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }], usage })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ choices: [{ message: { content: "ok" } }], usage });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(content)));
    const result = await new OpenAICompatibleProvider().complete(
      { ...profile(), streaming },
      [{ role: "user", content: "test" }],
      [],
      new AbortController().signal,
    );
    expect(result.usage).toEqual({
      promptTokens: 30,
      completionTokens: 10,
      totalTokens: 40,
    });
  }
});
it("counts persisted and active usage once and marks missing reports", () => {
  const event = {
    id: "u1",
    name: "model-usage",
    details: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
  };
  const conversation: any = {
    messages: [{ agentEvents: [event] }],
    lastRun: { events: [event, { id: "u2", name: "model-usage", details: {} }] },
  };
  expect(conversationUsage(conversation)).toEqual({
    promptTokens: 30,
    completionTokens: 10,
    totalTokens: 40,
    reported: 1,
    missing: 1,
  });
  expect(parseTokenUsage({ prompt_tokens: -1, completion_tokens: 1 })).toBeUndefined();
});
