import React from "react";
import { createRoot, Root } from "react-dom/client";
import { ChatManager } from "../core/chatManager";
import { ChatApp } from "../ui/ChatApp";
import { ModelProfile } from "../core/types";
import {
  getPref,
  setPref,
  readModelProfiles,
  writeModelProfiles,
} from "../utils/prefs";
import { fetchModelCatalog } from "../agent/modelCatalog";
import { locateSourceInCollection } from "./locateSource";
import { hostMenuText, zoteroMenuLanguage } from "./uiLocale";
import { MenuLocaleContext } from "../ui/menuLocale";

export class SidebarHost {
  private root?: Root;
  private container?: HTMLDivElement;
  private wrapper?: HTMLDivElement;
  private observer?: MutationObserver;
  private button?: HTMLElement;
  private toolsMenuItem?: HTMLElement;
  private itemMenuItem?: HTMLElement;
  private keyHandler?: (event: KeyboardEvent) => void;
  private popup?: Window;
  private unsubscribe?: () => void;
  private mode = "sidebar";
  private selectedProfileID?: string;
  private disposed = false;
  constructor(
    private readonly win: _ZoteroTypes.MainWindow,
    private readonly manager: ChatManager,
    private readonly getProfile: () => ModelProfile | undefined,
    private readonly getSettings: () => {
      systemPrompt: string;
      maxToolCalls: number;
      maxAttachments: number;
      developerDiagnostics?: boolean;
    },
    private readonly onExport: (
      markdown: string,
      suggestedName: string,
    ) => void | Promise<void>,
  ) {}

  mount(): void {
    const t = hostMenuText();
    if (this.wrapper) return;
    this.disposed = false;
    const doc = this.win.document;
    const host = this.findHost(doc);
    if (!host)
      throw new Error(
        `Unsupported Zotero ${Zotero.version} window layout: sidebar host not found`,
      );
    (doc.documentElement as HTMLElement | null)?.style.setProperty(
      "--zaichat-width",
      `${Number(getPref("sidebarWidth") || 420)}px`,
    );
    const wrapper = doc.createElement("div");
    wrapper.id = "zaichat-sidebar-wrapper";
    wrapper.style.cssText = `display:${getPref("sidebarOpen") ? "flex" : "none"};height:100%;width:var(--zaichat-width);min-width:320px;max-width:800px;flex:0 0 var(--zaichat-width);overflow:hidden;`;
    const resizer = doc.createElement("div");
    resizer.className = "zaichat-resizer";
    const container = doc.createElement("div");
    container.className = "zaichat-react-root";
    wrapper.append(resizer, container);
    host.append(wrapper);
    this.wrapper = wrapper;
    this.container = container;
    this.installResizer(resizer);
    this.installToolbarButton(doc);
    try {
      this.root = createRoot(container);
      this.root.render(
        <MenuLocaleContext.Provider value={zoteroMenuLanguage()}>
          <ChatApp
            manager={this.manager}
            window={this.win}
            getProfile={() =>
              readModelProfiles().find(
                (entry) => entry.id === this.selectedProfileID,
              ) || this.getProfile()
            }
            getDefaultProfileID={() => String(getPref("defaultModelProfileID") || "")}
            getProfiles={readModelProfiles}
            loadModels={(selected) => {
              const profile = selected || this.getProfile();
              if (!profile) throw new Error(t("请先在设置页配置提供商。"));
              return fetchModelCatalog(profile.baseURL, profile.apiKey);
            }}
            onSelectModel={(selection) => {
              if (this.manager.getSnapshot().running)
                throw new Error(t("请等待当前回答完成后切换模型。"));
              const { profileID, makeDefault, ...modelSettings } = selection;
              const profile = profileID
                ? readModelProfiles().find((entry) => entry.id === profileID)
                : this.getProfile();
              if (!profile) throw new Error(t("请先配置提供商。"));
              writeModelProfiles(
                readModelProfiles().map((entry) =>
                  entry.id === profile.id ? { ...entry, ...modelSettings } : entry,
                ),
              );
              this.selectedProfileID = profile.id;
              if (makeDefault) setPref("defaultModelProfileID", profile.id);
              this.manager.settingsChanged();
            }}
            getSettings={this.getSettings}
            onExport={this.onExport}
            onLocate={(source) => this.locateSource(source)}
            onOpen={(source) => this.openSource(source)}
            onOpenSettings={() =>
              Zotero.Utilities.Internal.openPreferences("zaichat-preferences")
            }
            onToggleDisplay={() =>
              this.changeDisplay(this.mode === "window" ? "sidebar" : "window", true)
            }
          />
        </MenuLocaleContext.Provider>,
      );
    } catch (error) {
      Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    }
    this.keyHandler = (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLocaleLowerCase() === "j"
      ) {
        event.preventDefault();
        this.toggle();
      }
    };
    this.win.addEventListener("keydown", this.keyHandler, true);
    const observer = new this.win.MutationObserver(() => {
      if (this.wrapper && !this.wrapper.isConnected) this.unmount();
    });
    observer.observe(host, { childList: true });
    this.observer = observer;
    this.mode = getPref("displayMode") === "window" ? "window" : "sidebar";
    if (this.mode === "window") {
      wrapper.style.display = "none";
      if (getPref("sidebarOpen")) this.openWindow();
    }
    this.unsubscribe = this.manager.subscribe(() => {
      const mode = getPref("displayMode") === "window" ? "window" : "sidebar";
      if (mode !== this.mode) this.changeDisplay(mode, false);
    });
  }

  private changeDisplay(mode: string, forceOpen: boolean): void {
    const visible =
      forceOpen ||
      Boolean(this.popup && !this.popup.closed) ||
      this.wrapper?.style.display === "flex";
    this.mode = mode;
    setPref("displayMode", mode);
    if (mode === "window") {
      if (this.wrapper) this.wrapper.style.display = "none";
      if (visible) this.openWindow();
    } else {
      this.returnToSidebar();
      this.popup?.close();
      this.popup = undefined;
      if (this.wrapper) this.wrapper.style.display = visible ? "flex" : "none";
    }
    setPref("sidebarOpen", visible);
    this.manager.settingsChanged();
  }

  private returnToSidebar(): void {
    if (!this.disposed && this.wrapper && this.container)
      this.wrapper.append(this.win.document.adoptNode(this.container));
  }

  private openWindow(): void {
    if (this.popup && !this.popup.closed) {
      this.popup.focus();
      return;
    }
    const popup = this.win.openDialog(
      "chrome://zaichat/content/chatWindow.xhtml",
      "",
      "chrome,dialog=no,resizable,centerscreen,width=820,height=760",
    ) as Window;
    this.popup = popup;
    const attach = () => {
      if (
        this.disposed ||
        this.popup !== popup ||
        this.mode !== "window" ||
        !this.container
      )
        return;
      const host = popup.document.getElementById("zaichat-window-root");
      if (!host) {
        Zotero.logError(new Error("ZaiChat window host missing"));
        this.changeDisplay("sidebar", true);
        return;
      }
      // Move the existing root: draft, context selection and live run stay intact.
      host.append(popup.document.adoptNode(this.container));
      popup.focus();
      popup.addEventListener(
        "unload",
        () => {
          if (this.popup !== popup) return;
          this.returnToSidebar();
          this.popup = undefined;
          if (this.mode === "window") setPref("sidebarOpen", false);
        },
        { once: true },
      );
    };
    // openDialog may finish loading synchronously; do not miss that load event.
    if (
      popup.document.readyState === "complete" &&
      popup.document.getElementById("zaichat-window-root")
    )
      attach();
    else popup.addEventListener("load", attach, { once: true });
  }

  toggle(): void {
    if (!this.wrapper) return;
    if (this.mode === "window") {
      setPref("sidebarOpen", true);
      this.openWindow();
      return;
    }
    const open = this.wrapper.style.display === "none";
    this.wrapper.style.display = open ? "flex" : "none";
    setPref("sidebarOpen", open);
  }
  unmount(): void {
    this.unsubscribe?.();
    this.returnToSidebar();
    this.disposed = true;
    this.popup?.close();
    this.popup = undefined;
    this.observer?.disconnect();
    if (this.keyHandler) this.win.removeEventListener("keydown", this.keyHandler, true);
    this.root?.unmount();
    this.wrapper?.remove();
    this.button?.remove();
    this.toolsMenuItem?.remove();
    this.itemMenuItem?.remove();
    this.root = undefined;
    this.wrapper = undefined;
    this.button = undefined;
    this.toolsMenuItem = undefined;
    this.itemMenuItem = undefined;
  }

  private findHost(doc: Document): HTMLElement | undefined {
    const candidates = [doc.querySelector("#zotero-pane-stack > hbox")];
    // Zotero's main chrome is a mix of XUL and HTML elements. XUL hosts are
    // valid DOM parents but are not instances of window.HTMLElement.
    return candidates.find((value): value is HTMLElement =>
      Boolean(value && value.ownerDocument === doc && "append" in value),
    );
  }
  private installToolbarButton(doc: Document): void {
    const t = hostMenuText();
    const toolbar = doc.getElementById("zotero-tabs-toolbar");
    if (toolbar) {
      try {
        const button = doc.createXULElement("toolbarbutton") as unknown as HTMLElement;
        button.setAttribute("id", "zaichat-toolbar-button");
        button.setAttribute("class", "zotero-tb-button zaichat-toolbar-button");
        button.setAttribute("label", "ZaiChat");
        button.setAttribute("tooltiptext", t("Toggle ZaiChat (Ctrl/Cmd+Shift+J)"));
        button.style.listStyleImage = `url(${rootURI}content/icons/icon20.png)`;
        button.addEventListener("command", () => this.toggle());
        const anchor = doc.getElementById("zotero-tb-sync-error");
        if (anchor?.parentElement === toolbar) toolbar.insertBefore(button, anchor);
        else toolbar.append(button);
        this.button = button;
      } catch (error) {
        Zotero.logError(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.installMenus(doc);
  }

  private installMenus(doc: Document): void {
    const t = hostMenuText();
    const createMenuItem = (id: string, label: string): HTMLElement => {
      const item = doc.createXULElement("menuitem") as unknown as HTMLElement;
      item.setAttribute("id", id);
      item.setAttribute("label", label);
      item.setAttribute("image", `${rootURI}content/icons/icon16.png`);
      item.setAttribute("class", "menuitem-iconic");
      item.addEventListener("command", () => this.toggle());
      return item;
    };
    const toolsMenu = doc.getElementById("menu_ToolsPopup");
    if (toolsMenu) {
      try {
        this.toolsMenuItem = createMenuItem(
          "zaichat-tools-menu-item",
          t("Open ZaiChat"),
        );
        toolsMenu.append(this.toolsMenuItem);
      } catch (error) {
        Zotero.logError(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (itemMenu) {
      try {
        this.itemMenuItem = createMenuItem(
          "zotero-itemmenu-zaichat-open",
          t("Open ZaiChat"),
        );
        itemMenu.append(this.itemMenuItem);
      } catch (error) {
        Zotero.logError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  private installResizer(resizer: HTMLElement): void {
    resizer.addEventListener("pointerdown", (rawEvent) => {
      const down = rawEvent as PointerEvent;
      const startX = down.clientX;
      const startWidth = this.wrapper?.getBoundingClientRect().width || 420;
      const move = (event: PointerEvent) => {
        const width = Math.max(320, Math.min(800, startWidth + startX - event.clientX));
        this.wrapper!.style.width = `${width}px`;
      };
      const up = () => {
        const width = Math.round(this.wrapper?.getBoundingClientRect().width || 420);
        setPref("sidebarWidth", width);
        this.win.removeEventListener("pointermove", move);
        this.win.removeEventListener("pointerup", up);
      };
      this.win.addEventListener("pointermove", move);
      this.win.addEventListener("pointerup", up);
    });
  }

  private locateSource(source: import("../core/types").SourceReference): void {
    void locateSourceInCollection(this.win, source).catch((error) => {
      Zotero.logError(error);
      this.win.alert(
        hostMenuText()("ZaiChat Locate failed: {error}", { error: String(error) }),
      );
    });
  }

  private openSource(source: import("../core/types").SourceReference): void {
    const attachment =
      source.attachment &&
      Zotero.Items.getByLibraryAndKey(
        source.attachment.libraryID,
        source.attachment.itemKey,
      );
    if (attachment) void (this.win as any).ZoteroPane?.viewAttachment?.(attachment.id);
    else this.locateSource(source);
  }
}
