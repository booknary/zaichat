import React, { useState } from "react";
import { ModelProfile } from "../core/types";
import { resolveProviderCapabilities } from "../agent/providerCapabilities";
import { useMenuText } from "./menuLocale";

export type ModelSelection = Pick<
  ModelProfile,
  "model" | "reasoningEnabled" | "reasoningEffort"
>;
export function ModelPicker({
  profile,
  loadModels,
  onSave,
  onClose,
}: {
  profile: ModelProfile;
  loadModels: () => Promise<string[]>;
  onSave: (value: ModelSelection) => void;
  onClose: () => void;
}) {
  const t = useMenuText();
  const [model, setModel] = useState(profile.model);
  const [models, setModels] = useState<string[]>([profile.model]);
  const [enabled, setEnabled] = useState(profile.reasoningEnabled);
  const [effort, setEffort] = useState(profile.reasoningEffort);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const values = resolveProviderCapabilities({
    baseURL: profile.baseURL,
    model,
  }).reasoningEffortValues;
  const selectedEffort = values.includes(effort) ? effort : values[0];
  return (
    <div
      className="zaichat-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="zaichat-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("切换模型")}
      >
        <div className="zaichat-dialog-header">
          <strong>{t("模型与思考强度")}</strong>
          <button onClick={onClose}>{t("关闭")}</button>
        </div>
        <p>{t("使用当前提供商和已保存的密钥，下次发送生效。")}</p>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setStatus(t("加载中…"));
            try {
              const ids = await loadModels();
              setModels([...new Set([profile.model, ...ids])]);
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
          <select
            value={models.includes(model) ? model : ""}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="" disabled>
              {t("手动输入的模型")}
            </option>
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <input
          aria-label={t("手动模型名称")}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t("启用思考")}
        </label>
        <label>
          {t("思考强度")}
          <select
            disabled={!enabled}
            value={selectedEffort}
            onChange={(e) =>
              setEffort(e.target.value as ModelProfile["reasoningEffort"])
            }
          >
            {values.map((value) => (
              <option key={value} value={value}>
                {t(value)}
              </option>
            ))}
          </select>
        </label>
        <p>
          {t(
            "档位来自插件的提供商适配规则，非模型列表接口返回；未知兼容服务需自行确认支持情况。",
          )}
        </p>
        <p role="status">{status}</p>
        <button
          disabled={!model.trim() || busy}
          onClick={() => {
            try {
              onSave({
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
