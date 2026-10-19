import { getPref, setPref } from "../src/utils/prefs";
import { hostMenuText } from "../src/host/uiLocale";

describe("Documentation screenshots (opt-in, synthetic data)", function () {
  it("presents real plugin UI for manually captured bilingual documentation", async function () {
    if (Services.env.get("ZAICHAT_DOCUMENTATION_CAPTURE") !== "1") return;
    this.timeout(600000);
    const profile = String(Zotero.Profile.dir);
    if (!profile.replace(/\\/g, "/").includes("/.scaffold/"))
      throw new Error("Documentation fixture requires the project-isolated profile");
    const markerRoot = PathUtils.join(profile, "zaichat-documentation");
    await IOUtils.makeDirectory(markerRoot, { ignoreExisting: true });
    const win = Zotero.getMainWindow();
    const plugin = (Zotero as any).ZaiChat;
    const manager = plugin.data.manager;
    const previousLocale = Zotero.locale;
    const previousProfiles = getPref("modelProfiles");
    const previousTitle = win.document.title;
    const collection = new Zotero.Collection();
    const paper = new Zotero.Item("journalArticle");
    let savedCollection = false,
      savedPaper = false;
    try {
      collection.name = "ZaiChat Demo — synthetic data";
      await collection.saveTx();
      savedCollection = true;
      paper.setField("title", "Demo paper: adaptation across mountain environments");
      paper.setField(
        "abstractNote",
        "Synthetic documentation example. This demonstration study compares plant populations along an elevation gradient and reports an association between habitat and flowering time. It does not establish a causal mechanism.",
      );
      paper.setField("date", "2026");
      paper.setField("publicationTitle", "Synthetic examples — not a published paper");
      paper.addToCollection(collection.id);
      await paper.saveTx();
      savedPaper = true;
      await win.ZoteroPane.collectionsView.selectByID(`C${collection.id}`);
      await win.ZoteroPane.selectItems([paper.id], { inLibraryRoot: false });
      setPref(
        "modelProfiles",
        JSON.stringify([
          {
            id: "documentation",
            displayName: "Demo — no API calls",
            baseURL: "https://api.openai.com/v1",
            apiKey: "",
            model: "your-chat-model",
            protocol: "auto",
            streaming: true,
            reasoningEnabled: false,
            reasoningEffort: "medium",
            timeoutMs: 45000,
            contextBudgetChars: 100000,
            evidenceBudgetChars: 60000,
          },
        ]),
      );
      setPref("sidebarOpen", true);
      setPref("sidebarWidth", 520);
      setPref("displayMode", "sidebar");
      manager.newConversation();
      const conversation = manager.getSnapshot().active;
      for (const phase of ["en-chat", "zh-chat", "zh-context"]) {
        (Zotero as any).locale = phase.startsWith("zh") ? "zh-CN" : "en-US";
        const chinese = phase.startsWith("zh");
        conversation.title = chinese
          ? "演示 · 摘要问答（非实时模型输出）"
          : "Demo · abstract Q&A (not a live response)";
        const source = {
          sourceID: "src-documentation-example",
          item: { libraryID: paper.libraryID, itemKey: paper.key },
          label: String(paper.getField("title")),
          field: "abstract",
          snippet: String(paper.getField("abstractNote")),
        };
        conversation.messages = [
          {
            id: "demo-user",
            role: "user",
            createdAt: new Date().toISOString(),
            displayText: chinese
              ? "请总结这篇演示文献的摘要。"
              : "Summarize this demonstration paper's abstract.",
          },
          {
            id: "demo-assistant",
            role: "assistant",
            createdAt: new Date().toISOString(),
            displayText: chinese
              ? "**预置演示回答，非实时模型输出。**\n\n这篇示例研究比较了不同海拔的植物种群，报告生境与开花时间之间的关联，但没有证明因果机制。[src-documentation-example]"
              : "**Prewritten documentation demo, not a live model response.**\n\nThis synthetic study compares plant populations along an elevation gradient. It reports an association between habitat and flowering time, not proof of a causal mechanism. [src-documentation-example]",
            sourceRefs: [source],
          },
        ];
        manager.repository.update(conversation);
        manager.selectConversation(conversation.id);
        await plugin.hooks.onMainWindowUnload(win);
        await plugin.hooks.onMainWindowLoad(win);
        win.document.title = `ZaiChat Documentation — ${phase}`;
        const root = win.document.querySelector(".zaichat-react-root")!;
        for (let i = 0; i < 100 && !root.querySelector("textarea"); i++)
          await Zotero.Promise.delay(50);
        const t = hostMenuText();
        if (phase === "zh-context")
          (
            root.querySelector(
              `[aria-label="${t("Choose context")}"]`,
            ) as HTMLButtonElement
          ).click();
        await Zotero.Promise.delay(300);
        await IOUtils.writeUTF8(
          PathUtils.join(markerRoot, "ready.json"),
          JSON.stringify({ phase, title: win.document.title }),
        );
        const deadline = Date.now() + 120000;
        while (!(await IOUtils.exists(PathUtils.join(markerRoot, `${phase}.done`)))) {
          if (Date.now() > deadline)
            throw new Error(`Documentation capture timed out: ${phase}`);
          await Zotero.Promise.delay(300);
        }
      }
    } catch (error) {
      throw {
        message: "Documentation screenshot fixture failed",
        expected: "Synthetic data and externally captured screenshots",
        actual: error instanceof Error ? error.stack || error.message : String(error),
      };
    } finally {
      (Zotero as any).locale = previousLocale;
      setPref("modelProfiles", previousProfiles);
      win.document.title = previousTitle;
      if (savedPaper) await paper.eraseTx();
      if (savedCollection) await collection.eraseTx();
      manager.newConversation();
      await plugin.hooks.onMainWindowUnload(win);
      await plugin.hooks.onMainWindowLoad(win);
    }
  });
});
