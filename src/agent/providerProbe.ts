import { ModelProfile } from "../core/types";
import { OpenAICompatibleProvider, ProviderMessage } from "./modelProvider";
import { resolveProviderCapabilities } from "./providerCapabilities";

export interface ProviderProbeCheck {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
}

export async function probeProviderCapabilities(
  profile: ModelProfile,
): Promise<ProviderProbeCheck[]> {
  const provider = new OpenAICompatibleProvider();
  const capabilities = resolveProviderCapabilities(profile);
  const checks: ProviderProbeCheck[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("provider capability test timed out"),
    Math.min(90_000, Math.max(15_000, profile.timeoutMs)),
  );
  const basicProfile = {
    ...profile,
    protocol: "native-tools" as const,
    streaming: false,
    reasoningEnabled: false,
  };
  try {
    await check(checks, "API", async () => {
      const response = await provider.complete(
        basicProfile,
        [{ role: "user", content: "Reply with exactly OK." }],
        [],
        controller.signal,
        undefined,
        { stage: "final-synthesis", maxTokens: 64 },
      );
      if (!response.text.trim()) throw new Error("empty completion");
    });

    if (capabilities.id !== "official-deepseek-v4") {
      checks.push(
        {
          name: "DeepSeek thinking",
          status: "SKIP",
          detail: capabilities.detectionReason,
        },
        {
          name: "DeepSeek tool round-trip",
          status: "SKIP",
          detail: "Provider-specific probe is only enabled for official DeepSeek V4",
        },
      );
      return checks;
    }

    const thinkingProfile = {
      ...basicProfile,
      reasoningEnabled: true,
      reasoningEffort: "high" as const,
    };
    await check(checks, "Thinking", async () => {
      const response = await provider.complete(
        thinkingProfile,
        [{ role: "user", content: "Think briefly, then reply with exactly OK." }],
        [],
        controller.signal,
        undefined,
        { stage: "final-synthesis", maxTokens: 256 },
      );
      if (!response.text.trim()) throw new Error("empty final content");
      if (!response.reasoningContent)
        throw new Error("reasoning_content was not returned");
    });

    const dummyTools = [
      {
        type: "function",
        function: {
          name: "diagnostic_echo",
          description:
            "Harmless capability-test tool. Call it once with the supplied value.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
    ];
    let toolMessages: ProviderMessage[] | undefined;
    await check(checks, "Tool calls", async () => {
      const initial: ProviderMessage[] = [
        {
          role: "system",
          content:
            "This is a harmless provider capability test. Call diagnostic_echo exactly once with value=probe, then use its result.",
        },
        { role: "user", content: "Run the diagnostic tool now." },
      ];
      const response = await provider.complete(
        thinkingProfile,
        initial,
        dummyTools,
        controller.signal,
        undefined,
        { stage: "tool-routing", maxTokens: 256 },
      );
      const tool = response.toolCalls.find((call) => call.name === "diagnostic_echo");
      if (!tool) throw new Error("model did not call diagnostic_echo");
      if (!response.reasoningContent)
        throw new Error("tool-call response omitted reasoning_content");
      toolMessages = [
        ...initial,
        { ...response.assistantMessage, protocolRequired: true },
        {
          role: "tool",
          tool_call_id: tool.id,
          content: JSON.stringify({ echoed: "probe" }),
          protocolRequired: true,
        },
      ];
    });

    if (toolMessages) {
      await check(checks, "Tool round-trip", async () => {
        const response = await provider.complete(
          thinkingProfile,
          toolMessages!,
          dummyTools,
          controller.signal,
          undefined,
          { stage: "final-synthesis", maxTokens: 256 },
        );
        if (!response.text.trim() && response.toolCalls.length)
          throw new Error("model repeated the dummy tool instead of completing");
        if (!response.text.trim()) throw new Error("empty post-tool response");
      });
    } else {
      checks.push({
        name: "Tool round-trip",
        status: "SKIP",
        detail: "Initial native tool call failed",
      });
    }

    if (profile.streaming) {
      await check(checks, "Streaming reasoning", async () => {
        let reasoningDelta = "";
        const response = await provider.complete(
          { ...thinkingProfile, streaming: true },
          [{ role: "user", content: "Think briefly, then reply with OK." }],
          [],
          controller.signal,
          undefined,
          {
            stage: "final-synthesis",
            maxTokens: 256,
            onReasoningDelta: (delta) => (reasoningDelta += delta),
          },
        );
        if (!reasoningDelta || reasoningDelta !== response.reasoningContent)
          throw new Error("streamed reasoning deltas were not preserved");
      });
    } else {
      checks.push({
        name: "Streaming reasoning",
        status: "SKIP",
        detail: "Streaming is disabled in this profile",
      });
    }
    return checks;
  } finally {
    clearTimeout(timeout);
  }
}

async function check(
  checks: ProviderProbeCheck[],
  name: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
    checks.push({ name, status: "PASS" });
  } catch (error) {
    checks.push({
      name,
      status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
