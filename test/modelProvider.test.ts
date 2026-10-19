import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelProfile } from "../src/core/types";
import {
  describeModelProviderError,
  ModelProviderError,
  OpenAICompatibleProvider,
  parseJSONAction,
} from "../src/agent/modelProvider";

afterEach(() => vi.unstubAllGlobals());

describe("strict JSON action protocol", () => {
  it("accepts only complete supported objects", () => {
    expect(parseJSONAction('{"type":"assistant","content":"done"}').text).toBe("done");
    expect(
      parseJSONAction(
        '{"type":"tool_calls","tool_calls":[{"id":"1","name":"search_library","arguments":{}}]}',
      ).toolCalls[0].name,
    ).toBe("search_library");
  });

  it("rejects markdown fences and surrounding prose", () => {
    expect(() =>
      parseJSONAction('```json\n{"type":"assistant","content":"x"}\n```'),
    ).toThrow(ModelProviderError);
    expect(() => parseJSONAction('Here: {"type":"assistant","content":"x"}')).toThrow(
      ModelProviderError,
    );
  });

  it("turns authentication failures into actionable guidance", () => {
    expect(
      describeModelProviderError(
        new ModelProviderError("Model request failed with HTTP 401", "http", 401),
      ),
    ).toContain("API key is invalid");
  });

  it("retries one transient fetch transport failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError("NetworkError when attempting to fetch resource."),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await new OpenAICompatibleProvider().complete(
      testProfile(),
      [{ role: "user", content: "hello" }],
      [],
      new AbortController().signal,
    );

    expect(response.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a persistent fetch transport failure with actionable guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new TypeError("NetworkError when attempting to fetch resource."),
        ),
    );

    const error = await new OpenAICompatibleProvider()
      .complete(
        testProfile(),
        [{ role: "user", content: "hello" }],
        [],
        new AbortController().signal,
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error.code).toBe("network");
    expect(describeModelProviderError(error)).toContain("one automatic retry");
  });
});

function testProfile(): ModelProfile {
  return {
    id: "network-test",
    displayName: "Network test",
    baseURL: "https://example.test/v1",
    apiKey: "",
    model: "test-model",
    protocol: "native-tools",
    streaming: false,
    reasoningEnabled: false,
    reasoningEffort: "medium",
    timeoutMs: 5000,
    contextBudgetChars: 100000,
    evidenceBudgetChars: 60000,
  };
}
