import { ModelProfile } from "../core/types";
import { detectProvider } from "./providerPresets";

export const reasoningModes = [
  ["auto", "Automatic (by endpoint and model)"],
  ["default", "Provider default (no extra parameters)"],
  ["enable-thinking", "enable_thinking (Bailian / Qwen)"],
  ["thinking", "thinking.type (DeepSeek / Ark)"],
  ["reasoning-effort", "reasoning_effort only"],
] as const;

export function reasoningLabel(profile: ModelProfile): string {
  const capabilities = resolveProviderCapabilities(profile);
  if (!capabilities.supportsThinking) return "Provider default";
  if (!profile.reasoningEnabled)
    return capabilities.explicitThinkingToggle ? "思考关闭" : "Provider default";
  return capabilities.supportsReasoningEffort
    ? stageModelOptions(profile, "tool-routing").reasoningEffort || "Thinking"
    : "Thinking";
}

export type AgentStage =
  | "search-planning"
  | "search-revision"
  | "tool-routing"
  | "evidence-verification"
  | "final-synthesis"
  | "write-proposal";

export interface ProviderCapabilities {
  id:
    | "official-deepseek-v4"
    | "bailian"
    | "ark"
    | "openai"
    | "generic-openai-compatible";
  thinkingParameter: "default" | "thinking" | "enable-thinking" | "reasoning-effort";
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
  thinkingParameter: "default",
  supportsThinking: false,
  supportsReasoningEffort: false,
  reasoningEffortValues: [],
  supportsToolCalls: true,
  supportsToolChoice: true,
  supportsToolChoiceInThinking: true,
  requiresReasoningContentForToolCalls: false,
  requiresAssistantContentForToolCalls: false,
  supportsStreamingReasoningContent: true,
  explicitThinkingToggle: false,
};

export function resolveProviderCapabilities(
  value: Pick<ModelProfile, "baseURL" | "model" | "reasoningMode" | "provider">,
): ProviderCapabilities {
  let capabilities = { ...GENERIC_CAPABILITIES };
  const provider = detectProvider(value);
  if (
    provider === "deepseek" &&
    /^deepseek-(?:v4(?:\.\d+)?-)?(?:flash|pro)(?:-\d+)?$/i.test(value.model)
  ) {
    capabilities = {
      id: "official-deepseek-v4",
      thinkingParameter: "thinking",
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
  if (provider === "bailian") {
    capabilities.id = "bailian";
    capabilities.displayName = "Alibaba Cloud Bailian";
    capabilities.detectionReason = "Matched an official Bailian endpoint";
    const model = value.model.toLowerCase();
    const deepseek = /^deepseek-v4(?:\.\d+)?-(?:flash|pro)(?:-\d+)?$/.test(model);
    const qwen =
      /^(?:qwen3(?:[.-]|$)|qwen-(?:plus|flash)(?:-|$))/.test(model) &&
      !/(?:thinking|instruct|coder|omni|embedding|rerank)/.test(model);
    if (deepseek || qwen) {
      capabilities.thinkingParameter = "enable-thinking";
      capabilities.supportsThinking = true;
      capabilities.explicitThinkingToggle = true;
      capabilities.supportsToolChoiceInThinking = false;
    }
    if (deepseek) {
      capabilities.requiresAssistantContentForToolCalls = true;
      capabilities.requiresReasoningContentForToolCalls = true;
      capabilities.supportsReasoningEffort = true;
      capabilities.reasoningEffortValues =
        model === "deepseek-v4-pro" ? ["high", "max"] : ["low", "high", "max"];
    }
  }
  if (provider === "ark") {
    capabilities.id = "ark";
    capabilities.displayName = "Volcano Ark";
    capabilities.detectionReason = "Volcano Ark chat endpoint";
    // Deployment IDs do not reveal the underlying model. Keep its defaults until explicitly configured.
    if (/^(?:doubao-seed-(?:1[.-][68]|2[.-])|deepseek-v[34])/.test(value.model)) {
      capabilities.thinkingParameter = "thinking";
      capabilities.supportsThinking = true;
      capabilities.explicitThinkingToggle = true;
      capabilities.requiresAssistantContentForToolCalls = true;
    }
    if (/^doubao-seed-(?:1-8|2-)/.test(value.model)) {
      capabilities.supportsReasoningEffort = true;
      capabilities.reasoningEffortValues = ["low", "medium", "high"];
    }
  }
  if (provider === "openai") {
    capabilities.id = "openai";
    capabilities.displayName = "OpenAI official";
    capabilities.detectionReason = "OpenAI API";
    capabilities.supportsStreamingReasoningContent = false;
    if (/^(?:gpt-[5-9](?:[.-]|$)|o[134](?:-|$))/.test(value.model)) {
      capabilities.thinkingParameter = "reasoning-effort";
      capabilities.supportsThinking = true;
      capabilities.supportsReasoningEffort = true;
      capabilities.reasoningEffortValues = /(?:^|-)pro(?:-|$)/.test(value.model)
        ? ["high"]
        : ["low", "medium", "high"];
    }
  }
  if (value.reasoningMode && value.reasoningMode !== "auto") {
    capabilities.thinkingParameter = value.reasoningMode;
    capabilities.supportsThinking = value.reasoningMode !== "default";
    capabilities.explicitThinkingToggle = ["thinking", "enable-thinking"].includes(
      value.reasoningMode,
    );
    capabilities.supportsReasoningEffort = value.reasoningMode === "reasoning-effort";
    capabilities.reasoningEffortValues = capabilities.supportsReasoningEffort
      ? ["low", "medium", "high", "max"]
      : [];
  }
  return capabilities;
}

export function isBailianEndpoint(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return (
      /^(?:dashscope(?:-intl|-us)?|dashscope\.[a-z0-9-]+)\.aliyuncs\.com$/.test(host) ||
      /^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/.test(host)
    );
  } catch {
    return false;
  }
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
  if (!capabilities.reasoningEffortValues.includes(profile.reasoningEffort)) {
    return {
      thinkingEnabled: true,
      reasoningEffort: capabilities.reasoningEffortValues.includes("high")
        ? "high"
        : capabilities.reasoningEffortValues[0],
    };
  }
  return { thinkingEnabled: true, reasoningEffort: profile.reasoningEffort };
}
