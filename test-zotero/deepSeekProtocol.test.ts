import { OpenAICompatibleProvider } from "../src/agent/modelProvider";
import type { ModelProfile } from "../src/core/types";

describe("DeepSeek empty-reasoning compatibility", function () {
  it("round-trips empty reasoning in JSON and SSE inside Zotero", async function () {
    if (!String(Zotero.Profile.dir).includes(".scaffold"))
      throw new Error("Protocol regression requires an isolated test profile");
    const runtime = globalThis as any;
    const win = Zotero.getMainWindow() as any;
    const originalFetch = runtime.fetch;
    const profile: ModelProfile = {
      id: "isolated-protocol-test",
      displayName: "Isolated test",
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
    const tools = [{ type: "function", function: { name: "diagnostic_echo" } }];
    try {
      for (const streaming of [false, true]) {
        let requests = 0;
        runtime.fetch = async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          if (body.thinking.type !== "enabled" || body.reasoning_effort !== "high")
            throw new Error("Thinking mode or effort changed unexpectedly");
          const first = requests++ === 0;
          if (!first && body.messages[0].reasoning_content !== "")
            throw new Error("Required empty reasoning field was not echoed");
          const message = first
            ? {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "synthetic-call",
                    type: "function",
                    function: { name: "diagnostic_echo", arguments: "{}" },
                  },
                ],
              }
            : { role: "assistant", content: "Completed" };
          const finish = first ? "tool_calls" : "stop";
          if (!streaming)
            return new win.Response(
              JSON.stringify({ choices: [{ message, finish_reason: finish }] }),
              { headers: { "Content-Type": "application/json" } },
            );
          const delta = first
            ? {
                ...message,
                tool_calls: message.tool_calls!.map((call) => ({ ...call, index: 0 })),
              }
            : message;
          const payload = `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
          return new win.Response(
            new win.ReadableStream({
              start(controller: any) {
                controller.enqueue(new win.TextEncoder().encode(payload));
                controller.close();
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        };
        const provider = new OpenAICompatibleProvider();
        const first = await provider.complete(
          { ...profile, streaming },
          [],
          tools,
          new win.AbortController().signal,
        );
        const final = await provider.complete(
          { ...profile, streaming },
          [
            first.assistantMessage,
            {
              role: "tool",
              tool_call_id: "synthetic-call",
              content: "{}",
            },
          ],
          tools,
          new win.AbortController().signal,
        );
        if (final.text !== "Completed" || requests !== 2)
          throw new Error("Synthetic tool round-trip did not complete");
      }
    } finally {
      runtime.fetch = originalFetch;
    }
  });
});
