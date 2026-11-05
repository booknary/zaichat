export async function captureUI(element: Element, name: string): Promise<void> {
  if (Services.env.get("ZAICHAT_BETA51_CAPTURE") !== "1") return;
  if (!String(Zotero.Profile.dir).includes(".scaffold"))
    throw new Error("UI capture requires isolation");
  const doc = element.ownerDocument!;
  const win = doc.defaultView!;
  const rect = element.getBoundingClientRect();
  const canvas = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas",
  ) as HTMLCanvasElement;
  canvas.width = Math.ceil(rect.width);
  canvas.height = Math.ceil(rect.height);
  const context = canvas.getContext("2d") as any;
  context.drawWindow(win, rect.x, rect.y, rect.width, rect.height, "rgb(255,255,255)");
  const data = win.atob(canvas.toDataURL("image/png").split(",")[1]);
  await IOUtils.write(
    PathUtils.join(Zotero.Profile.dir, "beta51-" + name + ".png"),
    Uint8Array.from(data, (c) => c.charCodeAt(0)),
  );
}
