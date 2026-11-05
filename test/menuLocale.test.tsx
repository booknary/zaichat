import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import {
  MenuLocaleContext,
  createMenuTranslator,
  menuLanguage,
} from "../src/ui/menuLocale";
import { hostMenuText, zoteroMenuLanguage } from "../src/host/uiLocale";
import { SourceCard, ChatApp } from "../src/ui/ChatApp";
import { ModelPicker } from "../src/ui/ModelPicker";
import { MessageText } from "../src/ui/MessageText";

afterEach(() => vi.unstubAllGlobals());
it("uses Zotero's interface locale with an English fallback", () => {
  for (const locale of ["zh-CN", "zh-TW", "zh_Hans", "zh"])
    expect(menuLanguage(locale)).toBe("zh-CN");
  for (const locale of ["en-US", "fr-FR", undefined])
    expect(menuLanguage(locale)).toBe("en-US");
  vi.stubGlobal("Zotero", { locale: "zh-CN" });
  expect(zoteroMenuLanguage()).toBe("zh-CN");
  expect(hostMenuText()("Open ZaiChat")).toBe("打开 ZaiChat");
  vi.stubGlobal("Zotero", { locale: "en-US" });
  expect(hostMenuText()("打开 ZaiChat")).toBe("Open ZaiChat");
});

it("interpolates labels without translating user/model content", () => {
  const t = createMenuTranslator("en-US");
  expect(t("Delete conversation “{title}”?", { title: "基因组创新" })).toBe(
    "Delete conversation “基因组创新”?",
  );
  expect(t("deepseek-v4-flash")).toBe("deepseek-v4-flash");
  expect(t("novelty genome innovation")).toBe("novelty genome innovation");
  const zh = createMenuTranslator("zh-CN");
  expect(zh("interrupted")).toBe("已中断");
  expect(zh("Completed with tool errors")).toBe("已完成（存在工具错误）");
  expect(zh("Reading: {title}", { title: "Original paper title" })).toBe(
    "正在阅读：Original paper title",
  );
  expect(zh("Selected text ({count} chars)", { count: 36 })).toBe(
    "选中文本（36 字符）",
  );
  expect(zh("Tool round-trip")).toBe("工具往返");
  expect(zh("PASS")).toBe("通过");
  expect(t("已中断")).toBe("interrupted");
});

it.each(["zh-CN", "en-US"] as const)(
  "renders consistent %s menus without changing stored values or evidence",
  (language) => {
    vi.stubGlobal("rootURI", "chrome://zaichat/");
    const profile = {
      id: "model",
      displayName: "Default",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      apiKey: "",
      protocol: "auto" as const,
      streaming: true,
      reasoningEnabled: true,
      reasoningEffort: "high" as const,
      timeoutMs: 45000,
      contextBudgetChars: 100000,
      evidenceBudgetChars: 60000,
    };
    const snapshot = {
      active: {
        id: "chat",
        title: "我的问题",
        messages: [
          {
            id: "message",
            role: "user",
            displayText: "创新 novelty genome",
          },
        ],
      },
      conversations: [],
      operations: [],
      running: false,
      status: "Ready",
    };
    const manager = {
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      getServerSnapshot: () => snapshot,
      availableContext: () => [],
    } as any;
    const source = {
      sourceID: "src-paper",
      item: { libraryID: 1, itemKey: "PAPER001" },
      label: "Paper novelty",
      field: "fulltext" as const,
      snippet: "Original evidence 内容",
    };
    const html = renderToStaticMarkup(
      <MenuLocaleContext.Provider value={language}>
        <ChatApp
          manager={manager}
          window={{} as any}
          getProfile={() => profile}
          getSettings={() => ({
            systemPrompt: "Unchanged prompt",
            maxToolCalls: 80,
            maxAttachments: 20,
          })}
          onExport={() => {}}
          onLocate={() => {}}
          onOpen={() => {}}
          onOpenSettings={() => {}}
        />
        <ModelPicker
          profile={profile}
          loadModels={async () => []}
          onSave={() => {}}
          onClose={() => {}}
        />
        <SourceCard source={source} onLocate={() => {}} onOpen={() => {}} />
        <MessageText text="Model answer **innovation** [src-unknown]" />
      </MenuLocaleContext.Provider>,
    );
    const t = createMenuTranslator(language);
    for (const label of [
      "Chat history",
      "New chat",
      "Choose context",
      "Stop",
      "Open",
      "Locate",
      "Save and use",
    ])
      if (label !== "Stop") expect(html).toContain(t(label));
    expect(html).toContain('value="high"');
    for (const effort of ["low", "high", "max"] as const) {
      const picker = renderToStaticMarkup(
        <MenuLocaleContext.Provider value={language}>
          <ModelPicker
            profile={{ ...profile, reasoningEffort: effort }}
            loadModels={async () => []}
            onSave={() => {}}
            onClose={() => {}}
          />
        </MenuLocaleContext.Provider>,
      );
      expect(picker).toContain('value="' + effort + '"');
      expect(picker).toContain('title="' + t(effort) + '"');
      expect(picker).not.toContain('value="medium"');
    }
    expect(html).not.toContain('value="medium"');
    expect(html).toContain("我的问题");
    expect(html).toContain("创新 novelty genome");
    expect(html).toContain("Original evidence 内容");
    expect(html).toContain("Model answer <strong>innovation</strong>");
    expect(html).toContain(t("[Source unavailable]"));
    expect(profile.reasoningEffort).toBe("high");
  },
);
