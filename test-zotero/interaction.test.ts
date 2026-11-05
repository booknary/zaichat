import { captureUI } from "./uiCapture";
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "../src/ui/ChatApp";
import { MenuLocaleContext } from "../src/ui/menuLocale";
import { RunInteraction, SteeringInterruption } from "../src/agent/runInteraction";
import type { ChatSnapshot } from "../src/core/chatManager";
import type { ModelProfile } from "../src/core/types";

describe("Interactive Agent workbench", function () {
  it("keeps running input editable, submits steer/queue, and replies without losing a draft", async function () {
    this.timeout(120000);
    // The test runner is a different window from the plugin bootstrap sandbox.
    const previousRootURI = (globalThis as any).rootURI;
    (globalThis as any).rootURI = "chrome://zaichat/";
    const win = Zotero.getMainWindow();
    const probe = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    probe.style.cssText =
      "position:fixed;right:12px;top:50px;width:380px;height:650px;z-index:99999";
    win.document.documentElement.append(probe);
    const root = createRoot(probe);
    const listeners = new Set<() => void>();
    let popup: Window | undefined;
    const edits: Array<{ id: string; text: string }> = [];
    const sent: Array<{ text: string; mode: string }> = [];
    let snapshot: ChatSnapshot = {
      conversations: [],
      running: true,
      runningConversationID: "synthetic",
      streamingText: "",
      queuePaused: false,
      queuedMessages: [],
      operations: [],
      status: "Agent is running",
      active: {
        schemaVersion: 1,
        id: "synthetic",
        title: "Synthetic interaction test",
        createdAt: "x",
        updatedAt: "x",
        messages: [
          { id: "user", role: "user", displayText: "Find a paper", createdAt: "x" },
        ],
        lastRun: {
          id: "run",
          conversationID: "synthetic",
          status: "running",
          startedAt: "x",
          toolCallCount: 1,
          events: [],
        },
      },
    };
    const manager = {
      getSnapshot: () => snapshot,
      getServerSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      availableContext: () => [],
      searchConversations: () => snapshot.conversations,
      editAndRerun: async (id: string, text: string) => {
        edits.push({ id, text });
      },
      submit: async (
        text: string,
        _context: unknown,
        _profile: unknown,
        _prompt: unknown,
        _limits: unknown,
        mode: string,
      ) => {
        sent.push({ text, mode });
      },
    };
    const profile: ModelProfile = {
      id: "synthetic",
      displayName: "Synthetic",
      apiKey: "",
      baseURL: "https://example.invalid",
      model: "synthetic",
      protocol: "native-tools",
      streaming: true,
      reasoningEnabled: true,
      reasoningEffort: "high",
      timeoutMs: 5000,
      contextBudgetChars: 100000,
      evidenceBudgetChars: 60000,
    };
    const wait = () => Zotero.Promise.delay(50);
    try {
      root.render(
        React.createElement(
          MenuLocaleContext.Provider,
          { value: "en-US" },
          React.createElement(ChatApp, {
            manager: manager as any,
            window: win,
            getProfile: () => profile,
            getSettings: () => ({
              systemPrompt: "Synthetic",
              maxToolCalls: 80,
              maxAttachments: 20,
            }),
            onExport: () => undefined,
            onLocate: () => undefined,
            onOpen: () => undefined,
            onOpenSettings: () => undefined,
          }),
        ),
      );
      for (
        let attempt = 0;
        attempt < 100 && !probe.querySelector("textarea");
        attempt++
      )
        await wait();
      const textarea = probe.querySelector("textarea") as HTMLTextAreaElement;
      if (!textarea || textarea.disabled)
        throw new Error("Running composer is disabled");
      const fill = async (text: string) => {
        Object.getOwnPropertyDescriptor(
          win.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(textarea, text);
        textarea.dispatchEvent(new win.Event("input", { bubbles: true }));
        await wait();
      };
      const followUp = probe.querySelector(
        '[aria-label="Follow-up behavior"]',
      ) as HTMLButtonElement;
      followUp.click();
      await wait();
      let menu = probe.querySelector(".zaichat-select-menu") as HTMLElement;
      if (
        menu.querySelectorAll('[role="option"]').length !== 2 ||
        menu.textContent?.split("Queue next message").length !== 2
      )
        throw new Error("Follow-up options duplicated");
      await captureUI(probe, "steering-menu");
      menu.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      await wait();
      menu.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      await wait();
      if (
        !followUp.textContent?.includes("Queue next message") ||
        probe.querySelector(".zaichat-select-menu")
      )
        throw new Error("Keyboard selection failed");
      followUp.click();
      await wait();
      (
        Array.from(probe.querySelectorAll('[role="option"]')).find((option) =>
          option.textContent?.includes("Steer this task"),
        ) as HTMLButtonElement
      ).click();
      await wait();
      followUp.click();
      await wait();
      menu = probe.querySelector(".zaichat-select-menu") as HTMLElement;
      menu.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await wait();
      if (probe.querySelector(".zaichat-select-menu"))
        throw new Error("Escape failed to close the menu");
      await fill("Use abbreviated authors");
      (probe.querySelector(".zaichat-send-button") as HTMLButtonElement).click();
      await wait();
      if (sent[0]?.mode !== "steer") throw new Error("Steering did not submit");
      await fill("Follow-up task");
      textarea.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await wait();
      if (sent[1]?.mode !== "queue") throw new Error("Queue shortcut did not submit");
      await fill("IME draft");
      textarea.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
        }),
      );
      await wait();
      if (sent.length !== 2) throw new Error("IME confirmation sent a message");
      snapshot = {
        ...snapshot,
        question: {
          id: "q",
          question: "Which scope?",
          choices: ["Full name", "Initials"],
        },
      };
      for (const listener of listeners) listener();
      await wait();
      await fill("Unsent clarification draft");
      (
        probe.querySelector(".zaichat-question-choices button") as HTMLButtonElement
      ).click();
      await wait();
      if (
        sent[2]?.text !== "Full name" ||
        sent[2]?.mode !== "steer" ||
        textarea.value !== "Unsent clarification draft"
      )
        throw new Error("Choice reply or draft preservation failed");
      for (const width of [320, 800]) {
        probe.style.width = `${width}px`;
        probe.style.height = "450px";
        await wait();
        const shell = probe.querySelector(".zaichat-shell") as HTMLElement;
        if (
          shell.scrollWidth > shell.clientWidth + 2 ||
          textarea.getBoundingClientRect().width > width
        )
          throw new Error(`Workbench overflows at ${width}px`);
        const sendButton = probe.querySelector(".zaichat-send-button")!;
        if (
          sendButton.getBoundingClientRect().bottom >
          shell.getBoundingClientRect().bottom + 2
        )
          throw new Error(`Composer is hidden below the workbench at ${width}px`);
      }
      snapshot = {
        ...snapshot,
        running: false,
        status: "Ready",
        question: undefined,
        conversations: [
          {
            id: "synthetic",
            title:
              "Synthetic literature conversation with a long title for readable history layout",
            createdAt: "2026-11-05T01:00:00Z",
            updatedAt: "2026-11-05T01:00:00Z",
          },
        ],
      };
      for (const listener of listeners) listener();
      popup = win.openDialog(
        "chrome://zaichat/content/chatWindow.xhtml",
        "",
        "chrome,dialog=no,resizable,width=820,height=760",
      ) as Window;
      for (
        let i = 0;
        i < 100 && !popup.document.getElementById("zaichat-window-root");
        i++
      )
        await wait();
      probe.style.cssText = "height:100%;width:100%";
      popup.document
        .getElementById("zaichat-window-root")!
        .append(popup.document.adoptNode(probe));
      await wait();
      (
        Array.from(probe.querySelectorAll("button")).find(
          (button) => button.textContent === "Edit & rerun",
        ) as HTMLButtonElement
      ).click();
      await wait();
      const editDialog = probe.querySelector(".zaichat-edit-dialog")!;
      await captureUI(probe, "edit-dialog");
      const editor = editDialog?.querySelector("textarea") as HTMLTextAreaElement;
      if (
        !editor ||
        editor.ownerDocument !== popup.document ||
        popup.document.activeElement !== editor
      )
        throw new Error("Edit dialog did not retain chat document/focus");
      Object.getOwnPropertyDescriptor(
        win.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(editor, "Edited synthetic request");
      editor.dispatchEvent(new win.Event("input", { bubbles: true }));
      await wait();
      (
        editDialog.querySelector(".zaichat-primary-button") as HTMLButtonElement
      ).click();
      await wait();
      if (
        edits[0]?.text !== "Edited synthetic request" ||
        edits[0]?.id !== "user" ||
        probe.querySelector(".zaichat-edit-dialog")
      )
        throw new Error("Edit and retry failed");
      (probe.querySelector('[aria-label="Chat history"]') as HTMLButtonElement).click();
      await wait();
      await captureUI(probe, "history");
      const historyRow = probe.querySelector(".zaichat-history-item")!;
      if (
        historyRow.getBoundingClientRect().height < 65 ||
        !historyRow.querySelector("time")
      )
        throw new Error("History rows remain cramped");
      (
        probe.querySelector('[aria-label="Close chat history"]') as HTMLButtonElement
      ).click();
      await wait();
      win.document.documentElement.append(win.document.adoptNode(probe));
      popup.close();
      popup = undefined;
      if (Services.env.get("ZAICHAT_WORKBENCH_CAPTURE") === "1") {
        if (!String(Zotero.Profile.dir).includes(".scaffold"))
          throw new Error("UI review requires isolation");
        const previousTitle = win.document.title;
        const donePath = PathUtils.join(
          Zotero.Profile.dir,
          `beta48-ui-${Date.now()}.done`,
        );
        try {
          win.document.title = "ZaiChat beta48 isolated UI review";
          snapshot = {
            ...snapshot,
            queuedMessages: [
              {
                id: "queued",
                text: "Read another paper after this task",
                createdAt: "x",
                contextRefs: {
                  items: [],
                  attachments: [],
                  notes: [],
                  annotations: [],
                  collections: [],
                },
              },
            ],
            active: {
              ...snapshot.active!,
              lastRun: { ...snapshot.active!.lastRun!, status: "waiting-user" },
              messages: [
                {
                  id: "demo-user",
                  role: "user",
                  displayText: "Find a remembered paper and verify its abstract.",
                  createdAt: "x",
                },
                {
                  id: "demo-answer",
                  role: "assistant",
                  displayText:
                    "## Evidence first\n\nThis is a **prewritten synthetic UI demonstration**, not a live model answer.\n\n- A candidate matches the remembered topic.\n- Its abstract is sufficient for identification.\n- Detailed evidence remains collapsed below. [demo-source]",
                  createdAt: "x",
                  sourceRefs: [
                    {
                      sourceID: "demo-source",
                      item: { libraryID: 1, itemKey: "DEMO0001" },
                      label: "Example literature result — synthetic data",
                      snippet: "Demonstration excerpt only.",
                      field: "abstract",
                    },
                  ],
                },
              ],
            },
          };
          probe.style.cssText =
            "position:fixed;right:20px;top:50px;width:min(760px, calc(100vw - 40px));height:calc(100vh - 90px);z-index:99999";
          for (const listener of listeners) listener();
          await wait();
          await IOUtils.writeUTF8(
            PathUtils.join(Zotero.Profile.dir, "beta48-ui-ready.json"),
            JSON.stringify({ title: win.document.title, donePath }),
          );
          const deadline = Date.now() + 90000;
          while (!(await IOUtils.exists(donePath)) && Date.now() < deadline)
            await Zotero.Promise.delay(500);
          if (!(await IOUtils.exists(donePath)))
            throw new Error("UI review completion marker not received");
        } finally {
          win.document.title = previousTitle;
        }
      }
    } catch (error) {
      throw {
        message: "Interactive workbench regression failed",
        expected:
          "Editable composer, steer/queue and preserved drafts without overflow",
        actual: String(error),
      };
    } finally {
      root.unmount();
      probe.remove();
      if (popup && !popup.closed) popup.close();
      if (previousRootURI === undefined) delete (globalThis as any).rootURI;
      else (globalThis as any).rootURI = previousRootURI;
    }
  });

  it("cancels a model request for guidance across Zotero's browser compartment", async function () {
    const interaction = new RunInteraction();
    const run = new AbortController();
    const result = interaction
      .request(
        run.signal,
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      )
      .catch((error) => error);
    interaction.submit({
      id: "synthetic",
      text: "New direction",
      context: {
        refs: {
          items: [],
          attachments: [],
          notes: [],
          annotations: [],
          collections: [],
        },
      },
    });
    if (!((await result) instanceof SteeringInterruption) || run.signal.aborted)
      throw new Error("Steering cancelled the task instead of only its model request");
  });
});
