import React, { useState } from "react";
import { ModelProfile } from "../core/types";
import {
  resolveProviderCapabilities,
  reasoningModes,
} from "../agent/providerCapabilities";
import { SelectMenu } from "./SelectMenu";
import { useMenuText } from "./menuLocale";

export type ModelSelection = Pick<
  ModelProfile,
  "model" | "reasoningEnabled" | "reasoningEffort" | "reasoningMode"
> & { profileID?: string; makeDefault?: boolean };
export function ModelPicker({
  profile,
  profiles = [profile],
  defaultProfileID,
  onOpenSettings,
  loadModels,
  onSave,
  onClose,
}: {
  profile: ModelProfile;
  profiles?: ModelProfile[];
  defaultProfileID?: string;
  onOpenSettings?: () => void;
  loadModels: (profile?: ModelProfile) => Promise<string[]>;
  onSave: (value: ModelSelection) => void;
  onClose: () => void;
}) {
  const t = useMenuText();
  const [selectedProfile, setSelectedProfile] = useState(profile);
  const [reasoningMode, setReasoningMode] = useState(profile.reasoningMode || "auto");
  const [model, setModel] = useState(profile.model);
  const [models, setModels] = useState<string[]>([profile.model]);
  const [enabled, setEnabled] = useState(profile.reasoningEnabled);
  const [effort, setEffort] = useState(profile.reasoningEffort);
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const capabilities = resolveProviderCapabilities({
    baseURL: selectedProfile.baseURL,
    provider: selectedProfile.provider,
    model,
    reasoningMode,
  });
  const values = capabilities.reasoningEffortValues;
  const selectedEffort = values.includes(effort) ? effort : values[0] || effort;
  return (
    <div
      className="zaichat-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="zaichat-dialog zaichat-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("切换模型")}
      >
        <div className="zaichat-dialog-header">
          <strong>{t("模型与思考强度")}</strong>
          <button aria-label={t("关闭")} onClick={onClose}>
            ×
          </button>
        </div>
        <label>
          {t("Saved model profiles")}
          <SelectMenu
            label={t("Saved model profiles")}
            value={selectedProfile.id}
            disabled={busy}
            options={profiles.map((entry) => ({
              value: entry.id,
              label:
                entry.displayName +
                " · " +
                entry.model +
                (entry.id === defaultProfileID ? " · " + t("Default") : ""),
            }))}
            onChange={(id) => {
              const next = profiles.find((entry) => entry.id === id);
              if (!next) return;
              setSelectedProfile(next);
              setModel(next.model);
              setModels([next.model]);
              setEnabled(next.reasoningEnabled);
              setEffort(next.reasoningEffort);
              setReasoningMode(next.reasoningMode || "auto");
              setStatus("");
            }}
          />
        </label>
        {onOpenSettings && (
          <button
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            {t("Manage model profiles")}
          </button>
        )}
        <p>{t("使用当前提供商和已保存的密钥，下次发送生效。")}</p>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setStatus(t("加载中…"));
            try {
              const ids = await loadModels(selectedProfile);
              setModels([...new Set([selectedProfile.model, ...ids])]);
              setStatus(
                t("Fetched {count} models. Not all support chat or tool calls.", {
                  count: ids.length,
                }),
              );
            } catch (error) {
              setStatus((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("获取提供商模型列表")}
        </button>
        <label>
          {t("模型")}
          <SelectMenu
            label={t("模型")}
            value={model}
            options={[...new Set([model, ...models])]
              .filter(Boolean)
              .map((id) => ({ value: id, label: id }))}
            onChange={setModel}
            searchable
            searchLabel={t("Search models")}
          />
        </label>
        <details className="zaichat-model-advanced">
          <summary>{t("手动模型名称")}</summary>
          <input
            aria-label={t("手动模型名称")}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </details>
        {capabilities.supportsThinking && (
          <label className="zaichat-checkbox-row">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t(
              capabilities.explicitThinkingToggle ? "启用思考" : "Set reasoning effort",
            )}
          </label>
        )}
        {capabilities.supportsReasoningEffort && (
          <label>
            {t("思考强度")}
            <SelectMenu
              label={t("思考强度")}
              value={selectedEffort}
              disabled={!enabled}
              options={values.map((value) => ({ value, label: t(value) }))}
              onChange={(value) => setEffort(value as ModelProfile["reasoningEffort"])}
            />
          </label>
        )}
        <details className="zaichat-model-advanced">
          <summary>{t("Advanced compatibility")}</summary>
          <label>
            {t("Reasoning parameter")}
            <SelectMenu
              label={t("Reasoning parameter")}
              value={reasoningMode}
              options={reasoningModes.map(([value, label]) => ({
                value,
                label: t(label),
              }))}
              onChange={(value) =>
                setReasoningMode(value as NonNullable<ModelProfile["reasoningMode"]>)
              }
            />
          </label>
          <p>
            {t(
              "Automatic uses known provider rules; unknown services keep provider defaults. Select an explicit parameter only if documented by your service.",
            )}
          </p>
        </details>
        {status && <p role="status">{status}</p>}
        <label className="zaichat-checkbox-row">
          <input
            type="checkbox"
            checked={makeDefault}
            onChange={(event) => setMakeDefault(event.target.checked)}
          />
          {t("Use as default on startup")}
        </label>
        <button
          disabled={!model.trim() || busy}
          onClick={() => {
            try {
              onSave({
                profileID: selectedProfile.id,
                makeDefault,
                reasoningMode,
                model: model.trim(),
                reasoningEnabled: enabled,
                reasoningEffort: selectedEffort,
              });
              onClose();
            } catch (error) {
              setStatus((error as Error).message);
            }
          }}
        >
          {t("保存并使用")}
        </button>
      </div>
    </div>
  );
}
