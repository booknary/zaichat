import { ModelProfile } from "../core/types";
import {
  OpenAICompatibleProvider,
  ProviderMessage,
  describeModelProviderError,
} from "./modelProvider";
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
  // Exercise native tools without auto-fallback, unless JSON actions were explicitly selected.
  const toolProfile = {
    ...profile,
    protocol:
      profile.protocol === "json-actions"
        ? ("json-actions" as const)
        : ("native-tools" as const),
  };
  const basicProfile = { ...toolProfile, reasoningEnabled: false };
  const thinking = capabilities.supportsThinking && profile.reasoningEnabled;
  const maxTokens = capabilities.supportsThinking ? 2048 : 128;
  try {
    await check(checks, "API", async () => {
      const response = await provider.complete(
        basicProfile,
        [{ role: "user", content: "Reply with exactly OK." }],
        [],
        controller.signal,
        undefined,
        { stage: "final-synthesis", maxTokens },
      );
      if (!response.text.trim()) throw new Error("Empty completion");
    });
    if (thinking) {
      await check(checks, "Thinking", async () => {
        const response = await provider.complete(
          toolProfile,
          [{ role: "user", content: "Think briefly, then reply with exactly OK." }],
          [],
          controller.signal,
          undefined,
          { stage: "final-synthesis", maxTokens },
        );
        if (!response.text.trim()) throw new Error("Empty completion");
        if (
          capabilities.thinkingParameter !== "reasoning-effort" &&
          !response.reasoningContent
        )
          throw new Error("No reasoning content returned; check model support");
      });
    }
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
    await check(
      checks,
      toolProfile.protocol === "json-actions" ? "JSON actions" : "Tool calls",
      async () => {
        const initial: ProviderMessage[] = [
          {
            role: "system",
            content:
              "This is a harmless provider capability test. Call diagnostic_echo exactly once with value=probe, then use its result. After receiving the tool result, reply with OK without calling another tool.",
          },
          { role: "user", content: "Run the diagnostic tool now." },
        ];
        const response = await provider.complete(
          toolProfile,
          initial,
          dummyTools,
          controller.signal,
          undefined,
          { stage: "tool-routing", maxTokens },
        );
        const tool = response.toolCalls[0];
        if (
          response.toolCalls.length !== 1 ||
          tool?.name !== "diagnostic_echo" ||
          !tool.arguments ||
          typeof tool.arguments !== "object" ||
          !("value" in tool.arguments) ||
          tool.arguments.value !== "probe"
        )
          throw new Error("Expected exactly one diagnostic_echo call with value=probe");
        if (
          thinking &&
          capabilities.requiresReasoningContentForToolCalls &&
          typeof response.assistantMessage.reasoning_content !== "string"
        )
          throw new Error("Tool history is missing reasoning_content");
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
      },
    );
    if (toolMessages) {
      await check(checks, "Tool round-trip", async () => {
        const response = await provider.complete(
          toolProfile,
          toolMessages!,
          dummyTools,
          controller.signal,
          undefined,
          { stage: "final-synthesis", maxTokens },
        );
        if (response.toolCalls.length)
          throw new Error("Model repeated the diagnostic tool instead of completing");
        if (!response.text.trim()) throw new Error("Empty post-tool response");
      });
    } else {
      checks.push({
        name: "Tool round-trip",
        status: "SKIP",
        detail: "Initial tool call failed",
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
    checks.push({ name, status: "FAIL", detail: describeModelProviderError(error) });
  }
}
