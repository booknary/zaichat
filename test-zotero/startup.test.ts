import { hostMenuText } from "../src/host/uiLocale";
import React from "react";
import { createRoot } from "react-dom/client";
import { MessageText } from "../src/ui/MessageText";
import {
  getPref,
  setPref,
  normalizeModelProfile,
  readModelProfiles,
  writeModelProfiles,
} from "../src/utils/prefs";

function t(text: string) {
  return hostMenuText()(text);
}

describe("ZaiChat startup", function () {
  it("contains Markdown tables and code inside a narrow chat and retains citation actions", async function () {
    const win = Zotero.getMainWindow();
    const shell = win.document.querySelector("#zaichat-sidebar-wrapper .zaichat-shell");
    if (!shell) throw new Error("Missing sidebar for Markdown layout check");
    const wrapper = win.document.getElementById(
      "zaichat-sidebar-wrapper",
    ) as HTMLElement;
    const previousDisplay = wrapper.style.display;
    wrapper.style.display = "flex";
    const probe = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    probe.style.cssText =
      "width:280px;min-width:280px;flex:none;position:absolute;left:0;top:0";
    shell.append(probe);
    const root = createRoot(probe);
    let located = false;
    try {
      root.render(
        React.createElement(MessageText, {
          text:
            "| A | B | C |\n| --- | --- | --- |\n| **Paper** | [src-layout] | evidence |\n\n```txt\n  " +
            "x".repeat(150) +
            "\n\n  end\n```",
          sources: [
            {
              sourceID: "src-layout",
              item: { libraryID: 1, itemKey: "TEST0001" },
              label: "Layout fixture",
            },
          ],
          onSource: () => {
            located = true;
          },
        }),
      );
      for (let attempt = 0; attempt < 100 && !probe.querySelector("table"); attempt++)
        await Zotero.Promise.delay(20);
      const table = probe.querySelector(".zaichat-table-scroll") as HTMLElement;
      const code = probe.querySelector("pre") as HTMLElement;
      if (!table || !code) throw new Error("Markdown blocks did not mount");
      for (const element of [table, code]) {
        if (
          element.getBoundingClientRect().width > 281 ||
          win.getComputedStyle(element).overflowX !== "auto"
        )
          throw new Error("Markdown overflow escaped its local container");
        if (element.scrollWidth <= element.clientWidth)
          throw new Error("Wide Markdown fixture did not produce local scrolling");
      }
      if (
        win.getComputedStyle(code).whiteSpace !== "pre" ||
        !code.textContent?.includes("\n\n  end")
      )
        throw new Error("Code whitespace was lost");
      (probe.querySelector(".zaichat-citation-button") as HTMLButtonElement).click();
      if (!located) throw new Error("Table citation action was lost");
    } catch (error) {
      throw {
        message: String(error),
        expected: "contained Markdown with working citations",
        actual: String(error),
      };
    } finally {
      root.unmount();
      probe.remove();
      wrapper.style.display = previousDisplay;
    }
  });

  it("defines and initializes the plugin instance", async function () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((Zotero as any).ZaiChat?.data?.initialized) break;
      await Zotero.Promise.delay(50);
    }
    const instance = (Zotero as any).ZaiChat;
    if (!instance?.data?.initialized) {
      const state = instance
        ? JSON.stringify({
            alive: instance.data?.alive,
            initialized: instance.data?.initialized,
            hasManager: Boolean(instance.data?.manager),
          })
        : "missing global instance";
      throw new Error(`Zotero.ZaiChat did not initialize: ${state}`);
    }
    const runtime = instance.data.runtimeChecks;
    if (!runtime?.abortController || !runtime?.fetch || !runtime?.textDecoder)
      throw new Error(
        `ZaiChat browser runtime is incomplete: ${JSON.stringify(runtime)}`,
      );
  });

  it("registers and renders the visible entry points and sidebar", async function () {
    const win = Zotero.getMainWindow();
    const wrapper = win?.document.getElementById("zaichat-sidebar-wrapper");
    if (!wrapper) throw new Error("ZaiChat sidebar was not mounted");
    if (wrapper.parentElement?.parentElement?.id !== "zotero-pane-stack")
      throw new Error("ZaiChat sidebar was mounted outside the tab layout");
    if (!win?.document.getElementById("zaichat-toolbar-button"))
      throw new Error("ZaiChat toolbar button was not mounted");
    if (!win?.document.getElementById("zotero-itemmenu-zaichat-open"))
      throw new Error("ZaiChat item context menu was not mounted");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (wrapper.querySelector(".zaichat-composer textarea")) break;
      await Zotero.Promise.delay(50);
    }
    if (!wrapper.querySelector(".zaichat-shell"))
      throw new Error("ZaiChat React shell was not rendered");
    if (!wrapper.querySelector(".zaichat-composer textarea"))
      throw new Error("ZaiChat composer was not rendered");
    if (!wrapper.querySelector(".zaichat-composer button"))
      throw new Error("ZaiChat send control was not rendered");
    if (!wrapper.textContent?.includes(t("Ask your library")))
      throw new Error("ZaiChat empty-state prompt was not rendered");
    if (!wrapper.style.flex.includes("var(--zaichat-width)"))
      throw new Error("ZaiChat sidebar has no fixed flex basis");
    const reactRoot = wrapper.querySelector(".zaichat-react-root") as HTMLElement;
    if (!reactRoot) throw new Error("ZaiChat namespaced React root is missing");
    if (wrapper.querySelector("header, main, footer"))
      throw new Error("ZaiChat contains semantic elements affected by host styles");
    const historyToggle = wrapper.querySelector(
      'button[aria-label="' + t("Chat history") + '"]',
    ) as HTMLButtonElement | null;
    const body = wrapper.querySelector(".zaichat-body") as HTMLElement | null;
    const chatMain = wrapper.querySelector(".zaichat-main") as HTMLElement | null;
    if (!historyToggle || !body || !chatMain)
      throw new Error("ZaiChat history layout controls are incomplete");
    if (
      wrapper.querySelector('[role="dialog"][aria-label="' + t("Chat history") + '"]')
    )
      throw new Error("ZaiChat history dialog is initially open");
    const initialDisplay = win.getComputedStyle(body).display;
    const initialWidth = chatMain.getBoundingClientRect().width;
    historyToggle.click();
    await Zotero.Promise.delay(50);
    const historyDialog = wrapper.querySelector(
      '[role="dialog"][aria-label="' + t("Chat history") + '"]',
    );
    if (!historyDialog)
      throw new Error("ZaiChat history dialog did not open after clicking the toggle");
    if (!historyDialog.querySelector(".zaichat-history-delete"))
      throw new Error("ZaiChat history rows have no direct delete control");
    if (win.getComputedStyle(body).display !== initialDisplay)
      throw new Error("Opening chat history changed the chat layout mode");
    if (Math.abs(chatMain.getBoundingClientRect().width - initialWidth) > 1)
      throw new Error("Opening chat history resized or obscured the chat column");
    const closeHistory = historyDialog.querySelector(
      'button[aria-label="' + t("Close chat history") + '"]',
    ) as HTMLButtonElement | null;
    if (!closeHistory) throw new Error("ZaiChat history dialog has no close control");
    closeHistory.click();
    await Zotero.Promise.delay(50);
    if (
      wrapper.querySelector('[role="dialog"][aria-label="' + t("Chat history") + '"]')
    )
      throw new Error("ZaiChat history dialog did not close");
    const contextButton = wrapper.querySelector(
      'button[aria-label="' + t("Choose context") + '"]',
    ) as HTMLButtonElement | null;
    if (!contextButton) throw new Error("ZaiChat context chooser is missing");
    contextButton.click();
    await Zotero.Promise.delay(50);
    const contextDialog = wrapper.querySelector(
      '[role="dialog"][aria-label="' + t("Choose context") + '"]',
    );
    if (!contextDialog) throw new Error("ZaiChat context dialog did not open");
    const closeContext = contextDialog.querySelector(
      'button[aria-label="' + t("Close context") + '"]',
    ) as HTMLButtonElement | null;
    if (!closeContext) throw new Error("ZaiChat context dialog has no close control");
    closeContext.click();
    await Zotero.Promise.delay(50);
    if (
      wrapper.querySelector('[role="dialog"][aria-label="' + t("Choose context") + '"]')
    )
      throw new Error("ZaiChat context dialog did not close");
    if (wrapper.textContent?.includes("sk-")) {
      throw new Error("Potential API key found in sidebar DOM");
    }
  });

  it("keeps chat typography consistent without nested font shrinking", async function () {
    const win = Zotero.getMainWindow();
    const probe = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    try {
      const shell = win.document
        .getElementById("zaichat-sidebar-wrapper")
        ?.querySelector(".zaichat-shell");
      if (!shell) throw new Error("Missing React shell for font checks");
      probe.setAttribute("class", "zaichat-message");
      const add = (parent: Element, tag: string, className = "") => {
        const child = win.document.createElementNS("http://www.w3.org/1999/xhtml", tag);
        if (className) child.setAttribute("class", className);
        child.textContent = "Typography";
        parent.append(child);
        return child;
      };
      const card = add(probe, "div", "zaichat-card");
      for (const tag of ["span", "small", "button"]) add(card, tag);
      add(add(add(probe, "details"), "details"), "summary");
      add(probe, "textarea");
      add(add(probe, "select"), "option");
      shell.append(probe);
      for (const role of ["user", "assistant"]) {
        const message = add(probe, "div", "zaichat-message");
        message.setAttribute("data-role", role);
        const bubble = add(message, "div", "zaichat-message-bubble");
        const style = win.getComputedStyle(bubble);
        const tail = win.getComputedStyle(bubble, "::before");
        if (
          style.borderTopLeftRadius !== "14px" ||
          tail.width !== "8px" ||
          tail.position !== "absolute"
        )
          throw new Error(`Missing ${role} bubble or tail`);
        if (role === "user" ? tail.right !== "-7px" : tail.left !== "-7px")
          throw new Error(`Wrong ${role} tail alignment`);
        const source = add(message, "div", "zaichat-source-entry");
        const sourceStyle = win.getComputedStyle(source);
        if (
          sourceStyle.backgroundColor !== "rgba(0, 0, 0, 0)" ||
          sourceStyle.borderTopWidth !== "0px"
        )
          throw new Error("Source actions unexpectedly framed as a bubble");
      }
      const bodySize = parseFloat(win.getComputedStyle(shell).fontSize);
      const buttonStyle = win.getComputedStyle(probe.querySelector("button")!);
      if (
        buttonStyle.display !== "inline-flex" ||
        buttonStyle.alignItems !== "center" ||
        buttonStyle.justifyContent !== "center"
      )
        throw new Error("Button labels are not flex-centered");
      for (const selector of [".zaichat-card span", "button", "textarea", "select"]) {
        const size = parseFloat(
          win.getComputedStyle(probe.querySelector(selector)!).fontSize,
        );
        if (Math.abs(size - bodySize) > 0.1)
          throw {
            message: `Body font mismatch: ${selector}`,
            expected: bodySize,
            actual: size,
          };
      }
      for (const selector of ["small", "details details summary"]) {
        const size = parseFloat(
          win.getComputedStyle(probe.querySelector(selector)!).fontSize,
        );
        if (size < bodySize * 0.9 || size > bodySize)
          throw {
            message: `Auxiliary font unexpectedly scaled: ${selector}`,
            expected: bodySize * 0.93,
            actual: size,
          };
      }
    } catch (error) {
      throw {
        message: "Typography check failed",
        expected: "consistent computed sizes",
        actual: String((error as any)?.message || error) + " " + JSON.stringify(error),
      };
    } finally {
      probe.remove();
    }
  });

  it("loads and renders the preference pane", async function () {
    let stage = "locate pane";
    try {
      const pane = Zotero.PreferencePanes.pluginPanes.find(
        (entry: any) => entry.pluginID === "zaichat@booknary.github.io",
      );
      if (pane?.id !== "zaichat-preferences")
        throw new Error("ZaiChat preference pane was not registered");
      stage = "open preferences";
      const prefWin = Zotero.Utilities.Internal.openPreferences(pane.id);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (prefWin?.document?.getElementById("zaichat-pref-save")) break;
        await Zotero.Promise.delay(50);
      }
      stage = "inspect controls";
      if (!prefWin?.document?.getElementById("zaichat-pref-save"))
        throw new Error("ZaiChat preference controls were not rendered");
      if (!prefWin?.document?.getElementById("zaichat-pref-test"))
        throw new Error("ZaiChat connection test control was not rendered");
      const semanticModels = prefWin.document.getElementById(
        "zaichat-semantic-model",
      ) as HTMLSelectElement;
      if (
        !semanticModels ||
        [...semanticModels.options].map((option) => option.value).join(",") !==
          "small,base,large"
      )
        throw new Error("The three E5 model choices are missing");
      if (!prefWin.document.getElementById("zaichat-semantic-install"))
        throw new Error("The E5 installation action is missing");
      const effort = prefWin?.document?.getElementById(
        "zaichat-pref-reasoning-effort",
      ) as HTMLSelectElement | null;
      const model = prefWin?.document?.getElementById(
        "zaichat-pref-model",
      ) as HTMLInputElement | null;
      const baseURL = prefWin?.document?.getElementById(
        "zaichat-pref-base-url",
      ) as HTMLInputElement | null;
      if (!effort || !model || !baseURL)
        throw new Error("ZaiChat reasoning controls were not rendered");
      if (![...effort.options].some((option) => option.value === "medium"))
        throw new Error("Generic reasoning controls do not include medium");
      stage = "switch provider capability";
      baseURL.value = "https://api.deepseek.com";
      model.value = "deepseek-v4-flash";
      const event = prefWin.document.createEvent("Event");
      event.initEvent("input", true, false);
      baseURL.dispatchEvent(event);
      const actualEfforts = [...effort.options].map((option) => option.value).join(",");
      if (actualEfforts !== "low,high,max")
        throw {
          message: "DeepSeek reasoning controls have incorrect effort levels",
          expected: "low,high,max",
          actual: actualEfforts,
        };
      // The scaffold owns this temporary Zotero process. Closing the returned
      // preferences window here can also close the test runner on Zotero 9.
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw {
        message: `Preference integration failed during ${stage}`,
        expected: stage,
        actual: error instanceof Error ? error.stack || error.message : String(error),
      };
    }
  });

  it("persists model settings and opens the chat model selector without a request", async function () {
    const saved = String(getPref("modelProfiles") || "[]");
    const savedDefault = String(getPref("defaultModelProfileID") || "");
    try {
      const profile = normalizeModelProfile({
        id: "ui-test",
        baseURL: "https://api.deepseek.com",
        model: "deepseek-flash",
        apiKey: "test-only-not-a-real-key",
        reasoningEnabled: true,
        reasoningEffort: "low",
      })!;
      writeModelProfiles([profile]);
      setPref("defaultModelProfileID", profile.id);
      (Zotero as any).ZaiChat.data.manager.settingsChanged();
      if (readModelProfiles()[0]?.apiKey !== profile.apiKey)
        throw new Error("Model settings did not round-trip");
      await Zotero.Promise.delay(100);
      const wrapper = Zotero.getMainWindow().document.getElementById(
        "zaichat-sidebar-wrapper",
      )!;
      const toggle = wrapper.querySelector(
        ".zaichat-heading > button",
      ) as HTMLButtonElement;
      if (!toggle?.textContent?.includes("deepseek-flash"))
        throw new Error("Chat model label did not refresh");
      toggle.click();
      await Zotero.Promise.delay(100);
      const dialog = wrapper.querySelector(
        '[role="dialog"][aria-label="' + t("切换模型") + '"]',
      );
      if (!dialog || dialog.querySelectorAll("select").length !== 2)
        throw new Error("Model and effort dropdowns are missing");
      const save = [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === t("保存并使用"),
      ) as HTMLButtonElement;
      save.click();
      await Zotero.Promise.delay(50);
      if (wrapper.querySelector('[role="dialog"][aria-label="' + t("切换模型") + '"]'))
        throw new Error("Model picker did not close after save");
      if (!wrapper.querySelector(".zaichat-token-usage"))
        throw new Error("Token usage label is missing");
    } finally {
      setPref("modelProfiles", saved);
      setPref("defaultModelProfileID", savedDefault);
      (Zotero as any).ZaiChat.data.manager.settingsChanged();
    }
  });
});
