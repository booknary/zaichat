import { ModelProfile } from "../core/types";

export type AgentStage =
  | "search-planning"
  | "search-revision"
  | "tool-routing"
  | "evidence-verification"
  | "final-synthesis"
  | "write-proposal";

export interface ProviderCapabilities {
  id: "official-deepseek-v4" | "generic-openai-compatible";
  displayName: string;
  detectionReason: string;
  supportsThinking: boolean;
  supportsReasoningEffort: boolean;
  reasoningEffortValues: Array<ModelProfile["reasoningEffort"]>;
  supportsToolCalls: boolean;
  supportsToolChoice: boolean;
  supportsToolChoiceInThinking: boolean;
  requiresReasoningContentForToolCalls: boolean;
  requiresAssistantContentForToolCalls: boolean;
  supportsStreamingReasoningContent: boolean;
  explicitThinkingToggle: boolean;
}

const GENERIC_CAPABILITIES: ProviderCapabilities = {
  id: "generic-openai-compatible",
  displayName: "Generic OpenAI-compatible",
  detectionReason: "No provider-specific capability profile matched",
  supportsThinking: true,
  supportsReasoningEffort: true,
  reasoningEffortValues: ["low", "medium", "high", "max"],
  supportsToolCalls: true,
  supportsToolChoice: true,
  supportsToolChoiceInThinking: true,
  requiresReasoningContentForToolCalls: false,
  requiresAssistantContentForToolCalls: false,
  supportsStreamingReasoningContent: true,
  explicitThinkingToggle: false,
};

export function resolveProviderCapabilities(
  value: Pick<ModelProfile, "baseURL" | "model">,
): ProviderCapabilities {
  if (isOfficialDeepSeekV4Profile(value)) {
    return {
      id: "official-deepseek-v4",
      displayName: "Official DeepSeek V4 OpenAI-compatible API",
      detectionReason:
        "Matched api.deepseek.com with a supported DeepSeek flash/pro model ID or alias",
      supportsThinking: true,
      supportsReasoningEffort: true,
      reasoningEffortValues: ["low", "high", "max"],
      supportsToolCalls: true,
      supportsToolChoice: true,
      supportsToolChoiceInThinking: false,
      requiresReasoningContentForToolCalls: true,
      requiresAssistantContentForToolCalls: true,
      supportsStreamingReasoningContent: true,
      explicitThinkingToggle: true,
    };
  }
  return { ...GENERIC_CAPABILITIES };
}

export function isOfficialDeepSeekV4Profile(value: {
  baseURL?: string;
  model?: string;
}): boolean {
  try {
    const url = new URL(String(value.baseURL || ""));
    return (
      url.hostname.toLocaleLowerCase() === "api.deepseek.com" &&
      /^deepseek-(?:v4-)?(?:flash|pro)$/i.test(String(value.model || "").trim())
    );
  } catch {
    return false;
  }
}

export function stageModelOptions(
  profile: ModelProfile,
  _stage: AgentStage,
): {
  thinkingEnabled: boolean;
  reasoningEffort?: ModelProfile["reasoningEffort"];
} {
  const capabilities = resolveProviderCapabilities(profile);
  const thinkingEnabled = capabilities.supportsThinking && profile.reasoningEnabled;
  if (!thinkingEnabled || !capabilities.supportsReasoningEffort)
    return { thinkingEnabled };
  if (capabilities.id === "official-deepseek-v4") {
    return {
      thinkingEnabled: true,
      reasoningEffort:
        profile.reasoningEffort === "medium" ? "high" : profile.reasoningEffort,
    };
  }
  return { thinkingEnabled: true, reasoningEffort: profile.reasoningEffort };
}
