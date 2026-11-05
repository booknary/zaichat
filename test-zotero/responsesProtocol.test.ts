import { OpenAICompatibleProvider } from "../src/agent/modelProvider";
import { normalizeModelProfile } from "../src/utils/prefs";

describe("OpenAI Responses host protocol", function () {
  it("preserves function IDs and opaque reasoning through JSON and SSE round trips", async function () {
    if (!String(Zotero.Profile.dir).includes(".scaffold"))
      throw new Error("Responses regression requires isolation");
    const runtime = globalThis as any;
    const originalFetch = runtime.fetch;
    const win = Zotero.getMainWindow() as any;
    const reasoning = {
      type: "reasoning",
      id: "rs-test",
      encrypted_content: "synthetic-state",
      summary: [],
    };
    try {
      for (const streaming of [false, true]) {
        let requests = 0;
        runtime.fetch = async (url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          if (!url.endsWith("/responses") || body.store !== false || body.messages)
            throw new Error("Responses request routing failed");
          const first = requests++ === 0;
          if (
            !first &&
            (!body.input.some(
              (item: any) => item.encrypted_content === "synthetic-state",
            ) ||
              body.input.at(-1).call_id !== "call-test")
          )
            throw new Error("Required reasoning or tool result was dropped");
          const output = first
            ? [
                reasoning,
                {
                  type: "function_call",
                  id: "fc-test",
                  call_id: "call-test",
                  name: "diagnostic_echo",
                  arguments: "{}",
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    { type: "output_text", text: "Completed", annotations: [] },
                  ],
                },
              ];
          const data = { status: "completed", output };
          return new win.Response(
            streaming
              ? "data: " +
                  JSON.stringify({ type: "response.completed", response: data }) +
                  "\n\n"
              : JSON.stringify(data),
          );
        };
        const provider = new OpenAICompatibleProvider();
        const profile = normalizeModelProfile({
          id: "responses-test",
          baseURL: "https://api.openai.com/v1",
          model: "gpt-5.4",
          streaming,
          reasoningEnabled: true,
          reasoningEffort: "high",
        })!;
        const tools = [
          {
            type: "function",
            function: {
              name: "diagnostic_echo",
              parameters: { type: "object", properties: {} },
            },
          },
        ];
        const first = await provider.complete(
          profile,
          [],
          tools,
          new win.AbortController().signal,
        );
        const last = await provider.complete(
          profile,
          [
            first.assistantMessage,
            { role: "tool", tool_call_id: "call-test", content: "done" },
          ],
          tools,
          new win.AbortController().signal,
        );
        if (last.text !== "Completed" || requests !== 2)
          throw new Error("Host Responses round trip failed");
      }
    } catch (error) {
      throw {
        message: "Responses host regression failed",
        expected: "JSON and SSE tool round trips",
        actual: String(error),
      };
    } finally {
      runtime.fetch = originalFetch;
    }
  });
});
