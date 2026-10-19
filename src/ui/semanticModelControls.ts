import { e5Manifest, e5ModelID, E5_MODEL_IDS } from "../semantic/modelCatalog";
import { SemanticModelInstaller } from "../semantic/semanticModelInstaller";
import { getPref } from "../utils/prefs";
import { hostMenuText } from "../host/uiLocale";

export function renderSemanticModelControls(win: Window): HTMLElement {
  const t = hostMenuText();
  const doc = win.document;
  const create = (tag: string) =>
    doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
  const section = create("section");
  const label = create("label");
  label.textContent = t("本地向量模型（与对话模型独立）");
  const selector = create("select") as HTMLSelectElement;
  selector.id = "zaichat-semantic-model";
  label.setAttribute("for", selector.id);
  for (const id of E5_MODEL_IDS) {
    const model = e5Manifest(id);
    const option = create("option") as HTMLOptionElement;
    option.value = id;
    option.textContent = `multilingual-e5-${id} · ${model.model!.dimensions} ${t("dimensions")} · ${size(model.files.reduce((sum, file) => sum + file.size, 0))}`;
    selector.append(option);
  }
  selector.value = String(getPref("semanticModelID") || "small");
  const installer = (Zotero as any).ZaiChat?.data?.semanticModelInstaller as
    | SemanticModelInstaller
    | undefined;
  const description = create("p");
  description.textContent = t(
    "Small 为轻量默认档；Base、Large 需要更多内存及索引时间，目前为测试选项（尚未完成完整权重的部署回归）。均使用 CPU，无需安装 Python。模型来自 Hugging Face 官方固定版本，下载后进行大小、SHA-256 和向量自检。切换档位需重启 Zotero，新模型建立独立索引，旧模型和索引保留。",
  );
  const status = create("pre");
  status.className = "zaichat-semantic-status";
  const actions = create("div");
  actions.className = "zaichat-pref-actions";
  const install = create("button") as HTMLButtonElement;
  install.textContent = t("下载、校验并设置");
  install.id = "zaichat-semantic-install";
  const cancel = create("button") as HTMLButtonElement;
  cancel.textContent = t("取消下载");
  cancel.disabled = true;
  const remove = create("button") as HTMLButtonElement;
  remove.textContent = t("删除所选模型文件");
  const refresh = create("button") as HTMLButtonElement;
  refresh.textContent = t("检查所选模型");
  let inspecting = 0;
  let localBusy = false;
  const update = async () => {
    if (!installer || localBusy) return;
    const request = ++inspecting;
    const id = e5ModelID(selector.value);
    try {
      status.textContent = t("正在检查文件及校验信息…");
      const info = await installer.inspect(id);
      if (request !== inspecting || localBusy) return;
      status.textContent = `${t("Current run")}: ${installer.activeModel}; ${t("Next startup")}: ${String(getPref("semanticModelID") || "small")}\n${t("Selected model")}: ${info.model.verified ? t("已安装并校验") : t("未安装或需修复")}\n${t("Model size")}: ${size(info.model.expectedSize)}\n${t("Storage location")}: ${info.model.location}\n${t("Index location")}: ${info.index.location}\n${info.model.failure || t("运行环境随 XPI 提供，模型不包含在 XPI 中。")}`;
      remove.disabled = id === installer.activeModel || !info.model.installed;
    } catch (error) {
      status.textContent = String(error);
    }
  };
  const setBusy = (busy: boolean) => {
    localBusy = busy;
    selector.disabled = busy;
    for (const button of [install, remove, refresh]) button.disabled = busy;
    cancel.disabled = !busy;
  };
  install.addEventListener("click", async () => {
    if (!installer || installer.busy) return;
    if ((Zotero as any).ZaiChat?.data?.manager?.getSnapshot?.()?.running) {
      status.textContent = t("请等待当前对话完成后部署模型。");
      return;
    }
    const id = e5ModelID(selector.value);
    const manifest = e5Manifest(id);
    if (
      !win.confirm(
        t(
          "Download multilingual-e5-{id} ({size}) and run a local self-test? Extra temporary disk space is required. Previous indexes are retained; failures do not change selection.",
          { id, size: size(manifest.files.reduce((sum, file) => sum + file.size, 0)) },
        ),
      )
    )
      return;
    setBusy(true);
    let lastProgress = 0;
    try {
      await installer.install(id, true, (received, total, file) => {
        if (total && received < total && Date.now() - lastProgress < 200) return;
        lastProgress = Date.now();
        status.textContent = total
          ? `${file}\n${size(received)} / ${size(total)}（${Math.floor((received / total) * 100)}%）`
          : file;
      });
      status.textContent = t(
        "下载和向量自检通过，选择已保存。请重启 Zotero 自动启用并建立该模型的索引。",
      );
    } catch (error) {
      status.textContent = t(
        "Deployment incomplete: {error}\nNo model switch or index deletion occurred. Previously deleted data is not restored. You may retry.",
        { error: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      setBusy(false);
      remove.disabled = id === installer.activeModel;
    }
  });
  cancel.addEventListener("click", () => {
    installer?.cancel();
    status.textContent = t(
      "正在取消；如已进入向量自检，将在自检结束后取消，不保存新选择。",
    );
  });
  remove.addEventListener("click", async () => {
    if (!installer || installer.busy) return;
    const id = e5ModelID(selector.value);
    if (
      !win.confirm(
        t("Delete {id} model files? Its index and Zotero papers are retained.", { id }),
      )
    )
      return;
    setBusy(true);
    try {
      await installer.deleteModel(id, true);
      status.textContent = t("模型文件已删除。");
    } catch (error) {
      status.textContent = String(error);
    } finally {
      setBusy(false);
    }
  });
  refresh.addEventListener("click", () => void update());
  selector.addEventListener("change", () => void update());
  win.addEventListener(
    "unload",
    () => {
      if (localBusy) installer?.cancel();
    },
    { once: true },
  );
  actions.append(install, cancel, remove, refresh);
  section.append(label, selector, description, status, actions);
  if (installer) void update();
  else {
    install.disabled = remove.disabled = refresh.disabled = true;
    status.textContent = t("模型部署管理器尚不可用。");
  }
  return section;
}

function size(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
