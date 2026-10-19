import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider, requestTimeouts } from "../src/agent/modelProvider";
import type { ModelProfile } from "../src/core/types";

const profile: ModelProfile = {
  id: "timeout-test",
  displayName: "Test",
  baseURL: "https://example.test/v1",
  apiKey: "",
  model: "test",
  protocol: "native-tools",
  streaming: true,
  reasoningEnabled: false,
  reasoningEffort: "high",
  timeoutMs: 45000,
  contextBudgetChars: 100000,
  evidenceBudgetChars: 60000,
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("model request deadlines", () => {
  it("gives reasoning an initial wait without changing effort", () => {
    expect(
      requestTimeouts({ ...profile, reasoningEnabled: true }, "search-planning")
        .initialMs,
    ).toBe(180000);
    expect(requestTimeouts(profile, "search-planning").initialMs).toBe(45000);
  });

  it("keeps an active reasoning/tool stream alive beyond the old total deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal.addEventListener("abort", () =>
                  controller.error(new Error("aborted")),
                );
                for (const time of [30000, 60000, 90000])
                  setTimeout(
                    () =>
                      controller.enqueue(
                        new TextEncoder().encode(
                          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
                        ),
                      ),
                    time,
                  );
                setTimeout(() => {
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
                    ),
                  );
                  controller.close();
                }, 120000);
              },
            }),
          ),
      ),
    );
    const result = new OpenAICompatibleProvider().complete(
      profile,
      [],
      [],
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(120000);
    expect((await result).text).toBe("done");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not silently replay a partially received stream", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal.addEventListener("abort", () =>
                  controller.error(new Error("aborted")),
                );
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
                  ),
                );
              },
            }),
          ),
      ),
    );
    const result = new OpenAICompatibleProvider()
      .complete(profile, [], [], new AbortController().signal)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(46000);
    expect((await result).message).toContain("stream stalled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries an empty timed-out request only once", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    const result = new OpenAICompatibleProvider()
      .complete(profile, [], [], new AbortController().signal)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(91000);
    expect((await result).code).toBe("timeout");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send a cancelled request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      new OpenAICompatibleProvider().complete(profile, [], [], controller.signal),
    ).rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });
});
