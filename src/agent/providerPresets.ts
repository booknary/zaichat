import type { ModelProfile } from "../core/types";

export const providerPresets = [
  { id: "auto", label: "Detect from API address", baseURL: "", model: "" },
  {
    id: "deepseek",
    label: "DeepSeek official",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-flash",
  },
  {
    id: "ark",
    label: "Volcano Ark",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    model: "",
  },
  {
    id: "bailian",
    label: "Alibaba Cloud Bailian",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  {
    id: "openai",
    label: "OpenAI official",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
  },
  { id: "custom", label: "Custom OpenAI-compatible", baseURL: "", model: "" },
] as const;

export function detectProvider(
  value: Pick<ModelProfile, "baseURL" | "provider">,
): NonNullable<ModelProfile["provider"]> {
  if (value.provider && value.provider !== "auto") return value.provider;
  try {
    const host = new URL(value.baseURL).hostname.toLowerCase();
    if (host === "api.deepseek.com") return "deepseek";
    if (host === "api.openai.com") return "openai";
    if (/^ark\.[a-z0-9-]+\.volces\.com$/.test(host)) return "ark";
    if (
      /^(?:dashscope(?:-intl|-us)?|dashscope\.[a-z0-9-]+)\.aliyuncs\.com$/.test(host) ||
      /^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/.test(host)
    )
      return "bailian";
  } catch {
    return "custom";
  }
  return "custom";
}

export function resolveAPIStyle(
  profile: Pick<ModelProfile, "baseURL" | "model" | "provider" | "apiStyle">,
): "chat-completions" | "responses" {
  if (profile.apiStyle && profile.apiStyle !== "auto") return profile.apiStyle;
  return detectProvider(profile) === "openai" &&
    /^(?:gpt-[5-9](?:[.-]|$)|o[134](?:-|$))/.test(profile.model)
    ? "responses"
    : "chat-completions";
}
