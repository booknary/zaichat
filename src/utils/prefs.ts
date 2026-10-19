import { config } from "../../package.json";
import { ModelProfile } from "../core/types";
import {
  isOfficialDeepSeekV4Profile,
  resolveProviderCapabilities,
} from "../agent/providerCapabilities";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

export function getPref<K extends keyof PluginPrefsMap>(key: K): PluginPrefsMap[K] {
  return Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as PluginPrefsMap[K];
}

export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, value, true);
}

export function readModelProfiles(): ModelProfile[] {
  try {
    const parsed = JSON.parse(String(getPref("modelProfiles") || "[]"));
    return Array.isArray(parsed)
      ? (parsed.map(normalizeModelProfile).filter(Boolean) as ModelProfile[])
      : [];
  } catch {
    return [];
  }
}

export function writeModelProfiles(profiles: ModelProfile[]): void {
  const normalized = profiles.map(normalizeModelProfile);
  if (normalized.some((entry) => !entry))
    throw new Error(
      "模型配置未保存：请检查模型名称和 API 地址（远程地址必须使用 HTTPS）。",
    );
  setPref("modelProfiles", JSON.stringify(normalized));
  if (String(getPref("modelProfiles")) !== JSON.stringify(normalized))
    throw new Error("模型配置保存校验失败，请重试。");
  (Zotero as any).ZaiChat?.data?.manager?.settingsChanged();
}

export function normalizeModelProfile(value: any): ModelProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const baseURL = String(value.baseURL || "")
    .trim()
    .replace(/\/+$/, "");
  const model = String(value.model || "").trim();
  const id = String(value.id || "").trim();
  if (!id || !baseURL || !model || !isAllowedBaseURL(baseURL)) return undefined;
  const protocol = ["auto", "native-tools", "json-actions"].includes(value.protocol)
    ? value.protocol
    : "auto";
  const capabilities = resolveProviderCapabilities({ baseURL, model });
  const allowedEfforts = capabilities.reasoningEffortValues;
  const requestedEffort = String(value.reasoningEffort || "medium");
  const reasoningEffort = allowedEfforts.includes(requestedEffort as any)
    ? (requestedEffort as ModelProfile["reasoningEffort"])
    : capabilities.id === "official-deepseek-v4"
      ? "high"
      : "medium";
  return {
    id,
    displayName: String(value.displayName || model).trim() || model,
    baseURL,
    apiKey: String(value.apiKey || "").trim(),
    model,
    protocol,
    streaming: value.streaming !== false,
    reasoningEnabled: Boolean(value.reasoningEnabled),
    reasoningEffort,
    timeoutMs: clampNumber(value.timeoutMs, 5000, 600000, 45000),
    contextBudgetChars: clampNumber(value.contextBudgetChars, 10000, 500000, 100000),
    evidenceBudgetChars: clampNumber(value.evidenceBudgetChars, 5000, 300000, 60000),
  };
}

export function isDeepSeekProfile(value: {
  baseURL?: string;
  model?: string;
}): boolean {
  return isOfficialDeepSeekV4Profile(value);
}

export function isAllowedBaseURL(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, Math.round(number)))
    : fallback;
}
