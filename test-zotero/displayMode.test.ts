import { hostMenuText } from "../src/host/uiLocale";
import { getPref, setPref } from "../src/utils/prefs";

function t(text: string) {
  return hostMenuText()(text);
}

describe("ZaiChat display mode", function () {
  it("moves the live React root to a window and back without losing the draft", async function () {
    const main = Zotero.getMainWindow();
    const previous = String(getPref("displayMode") || "sidebar");
    const manager = (Zotero as any).ZaiChat.data.manager;
    let popup: Window | undefined;
    let opened: Window | undefined;
    const originalOpen = main.openDialog;
    (main as any).openDialog = (...args: any[]) => {
      opened = originalOpen.apply(main, args as any);
      return opened;
    };
    try {
      setPref("displayMode", "sidebar");
      manager.settingsChanged();
      const root = main.document.querySelector(".zaichat-react-root")!;
      const textarea = root.querySelector("textarea") as HTMLTextAreaElement;
      const change = (value: string) => {
        const setter = Object.getOwnPropertyDescriptor(
          main.HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(textarea, value);
        textarea.dispatchEvent(new main.Event("input", { bubbles: true }));
      };
      change("unsent display-mode test draft");
      (
        root.querySelector(
          '[aria-label="' + t("切换显示方式") + '"]',
        ) as HTMLButtonElement
      ).click();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          root.ownerDocument !== main.document &&
          root.ownerDocument?.getElementById("zaichat-window-root")
        )
          break;
        await Zotero.Promise.delay(30);
      }
      popup = root.ownerDocument?.defaultView || undefined;
      if (!popup || popup === main)
        throw new Error("Chat root did not move to the standalone window");
      const bounds = root.getBoundingClientRect();
      if (bounds.width < 300 || bounds.height < 300)
        throw new Error(`Collapsed popup layout: ${bounds.width} x ${bounds.height}`);
      if (
        popup.getComputedStyle(root.querySelector(".zaichat-shell")!).display !== "flex"
      )
        throw new Error("Popup stylesheet not loaded");
      if (textarea.value !== "unsent display-mode test draft")
        throw new Error("Draft lost on detach");
      (
        root.querySelector(
          '[aria-label="' + t("Chat history") + '"]',
        ) as HTMLButtonElement
      ).click();
      await Zotero.Promise.delay(50);
      if (
        !root.querySelector('[role="dialog"][aria-label="' + t("Chat history") + '"]')
      )
        throw new Error("React events failed after document adoption");
      (
        root.querySelector(
          '[aria-label="' + t("Close chat history") + '"]',
        ) as HTMLButtonElement
      ).click();
      (
        root.querySelector(
          '[aria-label="' + t("切换显示方式") + '"]',
        ) as HTMLButtonElement
      ).click();
      await Zotero.Promise.delay(80);
      if (root.ownerDocument !== main.document || !root.isConnected)
        throw new Error("Chat root did not return to the sidebar");
      if (textarea.value !== "unsent display-mode test draft")
        throw new Error("Draft lost on reattach");
      // Preference changes use the same path as the settings dropdown.
      setPref("displayMode", "window");
      manager.settingsChanged();
      for (
        let attempt = 0;
        attempt < 100 && root.ownerDocument === main.document;
        attempt++
      )
        await Zotero.Promise.delay(30);
      popup = root.ownerDocument?.defaultView || undefined;
      if (!popup || popup === main) throw new Error("Popup did not reopen");
      popup.close();
      await Zotero.Promise.delay(80);
      if (root.ownerDocument !== main.document || !root.isConnected)
        throw new Error("Closing popup lost the live root");
      change("");
    } catch (error) {
      throw {
        message: "Display mode lifecycle failed",
        expected: "same live root and draft",
        actual:
          String(error) +
          JSON.stringify({
            mode: getPref("displayMode"),
            uri: opened?.document?.documentURI,
            state: opened?.document?.readyState,
            closed: opened?.closed,
            html: opened?.document?.documentElement?.outerHTML?.slice(0, 1600),
          }),
      };
    } finally {
      main.openDialog = originalOpen;
      setPref("displayMode", "sidebar");
      manager.settingsChanged();
      if (popup && popup !== main && !popup.closed) popup.close();
      setPref("displayMode", previous);
      manager.settingsChanged();
    }
  });
});
