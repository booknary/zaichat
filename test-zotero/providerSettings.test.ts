import { captureUI } from "./uiCapture";
import React from "react";
import { createRoot } from "react-dom/client";
import { ModelPicker, ModelSelection } from "../src/ui/ModelPicker";
import { MenuLocaleContext } from "../src/ui/menuLocale";
import { renderPreferences } from "../src/ui/preferences";
import {
  normalizeModelProfile,
  getPref,
  setPref,
  writeModelProfiles,
} from "../src/utils/prefs";

function requireIsolation() {
  if (!String(Zotero.Profile.dir).includes(".scaffold"))
    throw new Error("Settings regression requires an isolated test profile");
}

describe("Provider settings and model switching", function () {
  it("switches profiles with the matching model and reasoning settings in a narrow dialog", async function () {
    requireIsolation();
    const win = Zotero.getMainWindow();
    const probe = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    probe.style.cssText =
      "position:fixed;right:10px;top:50px;width:320px;height:450px;z-index:99999";
    win.document.documentElement.append(probe);
    probe.className = "zaichat-shell";
    const root = createRoot(probe);
    const first = normalizeModelProfile({
      id: "a",
      displayName: "DeepSeek 官方",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-flash",
      reasoningEnabled: true,
      reasoningEffort: "high",
    })!;
    const second = normalizeModelProfile({
      id: "b",
      displayName: "阿里云百炼",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "deepseek-v4.1-flash-1017",
      reasoningEnabled: false,
    })!;
    let selected: ModelSelection | undefined;
    let loadedID = "";
    try {
      root.render(
        React.createElement(
          MenuLocaleContext.Provider,
          { value: "en-US" },
          React.createElement(ModelPicker, {
            profile: first,
            profiles: [first, second],
            loadModels: async (value) => {
              loadedID = value!.id;
              return [value!.model];
            },
            onSave: (value) => {
              selected = value;
            },
            onClose: () => undefined,
          }),
        ),
      );
      for (let i = 0; i < 100 && !probe.querySelector('[role="combobox"]'); i++)
        await Zotero.Promise.delay(20);
      const select = probe.querySelector(
        '[aria-label="Saved model profiles"]',
      ) as HTMLButtonElement;
      select.click();
      await Zotero.Promise.delay(50);
      const choices = Array.from(
        probe.querySelectorAll('[role="option"]'),
      ) as HTMLButtonElement[];
      if (
        choices.length !== 2 ||
        choices.some(
          (choice) => (choice.textContent || "").split("阿里云百炼").length > 2,
        )
      )
        throw new Error("Duplicate profile options");
      const menu = probe.querySelector(".zaichat-select-menu") as HTMLElement;
      await captureUI(probe, "model-menu");
      const bounds = probe.getBoundingClientRect();
      const menuBounds = menu.getBoundingClientRect();
      if (
        menuBounds.left < bounds.left ||
        menuBounds.right > bounds.right + 1 ||
        menuBounds.bottom > bounds.bottom + 1
      )
        throw new Error("Expanded menu escapes the narrow chat");
      choices.find((choice) => choice.textContent?.includes("阿里云百炼"))!.click();
      await Zotero.Promise.delay(50);
      const input = probe.querySelector(
        '[aria-label="Manual model name"]',
      ) as HTMLInputElement;
      if (input?.value !== "deepseek-v4.1-flash-1017")
        throw new Error("Model did not follow selected profile");
      const buttons = Array.from(probe.querySelectorAll("button"));
      const fetchButton = buttons.find(
        (button) => button.textContent === "Fetch provider model list",
      )!;
      fetchButton.click();
      await Zotero.Promise.delay(50);
      if (probe.querySelector(".zaichat-select-menu"))
        throw new Error("Menu stayed open after selection");
      if (loadedID !== "b") throw new Error("Catalog used the wrong provider profile");
      const dialog = probe.querySelector(".zaichat-dialog") as HTMLElement;
      if (dialog.scrollWidth > dialog.clientWidth + 2)
        throw new Error(
          "Model dialog overflows at 320px: " +
            JSON.stringify({
              width: dialog.clientWidth,
              scroll: dialog.scrollWidth,
              children: Array.from(dialog.querySelectorAll("*"))
                .map((entry) => ({
                  tag: entry.tagName,
                  text: entry.textContent?.slice(0, 50),
                  width: (entry as HTMLElement).clientWidth,
                  scroll: (entry as HTMLElement).scrollWidth,
                  right: entry.getBoundingClientRect().right,
                  parentRight: dialog.getBoundingClientRect().right,
                }))
                .filter((entry) => entry.scroll > entry.width + 2),
            }),
        );
      buttons.find((button) => button.textContent === "Save and use")!.click();
      if (
        selected?.profileID !== "b" ||
        selected.model !== "deepseek-v4.1-flash-1017" ||
        selected.reasoningEnabled
      )
        throw new Error("Saved selection does not match the chosen profile");
    } catch (error) {
      throw {
        message: "Provider picker regression failed",
        expected: "Matching profile, usable controls and no overflow",
        actual: String(error),
      };
    } finally {
      root.unmount();
      probe.remove();
    }
  });

  it("edits independent profiles and creates a new form without reusing another provider's key", async function () {
    requireIsolation();
    const win = Zotero.getMainWindow();
    const previous = getPref("modelProfiles");
    const previousDefault = getPref("defaultModelProfileID");
    const probe = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    probe.id = "zaichat-preferences-root";
    win.document.documentElement.append(probe);
    try {
      const profile = normalizeModelProfile({
        id: "test-bailian",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "deepseek-v4.1-flash-1017",
        apiKey: "synthetic-only",
        reasoningEnabled: true,
        reasoningEffort: "medium",
      })!;
      const other = normalizeModelProfile({
        ...profile,
        id: "test-other",
        displayName: "Other platform",
      })!;
      writeModelProfiles([profile, other]);
      setPref("defaultModelProfileID", profile.id);
      renderPreferences(win);
      const platforms = probe.querySelector(
        "#zaichat-pref-platform",
      ) as HTMLSelectElement;
      for (const id of ["deepseek", "ark", "bailian", "openai"])
        if (
          !Array.from(platforms.options).some(
            (entry) => (entry as HTMLOptionElement).value === id,
          )
        )
          throw new Error("Missing platform preset: " + id);
      const effort = probe.querySelector(
        "#zaichat-pref-reasoning-effort",
      ) as HTMLSelectElement;
      if (effort.value !== "high" || effort.disabled)
        throw new Error("Bailian effort controls are inconsistent");
      const savedList = probe.querySelector(
        "#zaichat-pref-profiles",
      ) as HTMLSelectElement;
      savedList.value = other.id;
      savedList.dispatchEvent(new win.Event("change", { bubbles: true }));
      const originalAlert = win.alert;
      try {
        win.alert = () => undefined;
        (probe.querySelector("#zaichat-pref-save") as HTMLButtonElement).click();
        if (getPref("defaultModelProfileID") !== profile.id)
          throw new Error("Saving another profile silently changed the default");
        (probe.querySelector("#zaichat-pref-set-default") as HTMLButtonElement).click();
        if (getPref("defaultModelProfileID") !== other.id)
          throw new Error("Explicit default selection failed");
      } finally {
        win.alert = originalAlert;
      }
      (probe.querySelector("#zaichat-pref-add-profile") as HTMLButtonElement).click();
      const key = probe.querySelector('input[type="password"]') as HTMLInputElement;
      if (key.value) throw new Error("New profile inherited a credential");
      const platform = probe.querySelector(
        "#zaichat-pref-platform",
      ) as HTMLSelectElement;
      platform.value = "ark";
      platform.dispatchEvent(new win.Event("change", { bubbles: true }));
      if (
        !(
          probe.querySelector("#zaichat-pref-base-url") as HTMLInputElement
        ).value.includes("ark.cn-beijing.volces.com/api/v3")
      )
        throw new Error("Ark template did not set the chat endpoint");
      const select = probe.querySelector("#zaichat-pref-profiles") as HTMLSelectElement;
      if (select.options.length !== 3)
        throw new Error("Existing profile disappeared from the editor");
      select.value = profile.id;
      select.dispatchEvent(new win.Event("change", { bubbles: true }));
      if (
        (probe.querySelector("#zaichat-pref-model") as HTMLInputElement).value !==
        profile.model
      )
        throw new Error("Saved profile could not be reopened");
    } finally {
      setPref("modelProfiles", previous);
      setPref("defaultModelProfileID", previousDefault);
      probe.remove();
    }
  });
});
