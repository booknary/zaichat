import { e5Manifest } from "../src/semantic/modelCatalog";

describe("Semantic network transport", function () {
  it("probes real model requests inside Zotero when explicitly enabled", async function () {
    if (!Services.env.get("ZAICHAT_NETWORK_PROBE")) return;
    this.timeout(140000);
    const results: string[] = [];
    for (const path of ["README.md", "onnx/model.onnx"]) {
      const file = e5Manifest("small").files.find(
        (entry) => entry.relativePath === path,
      )!;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        const response = await Zotero.getMainWindow().fetch(file.url, {
          signal: controller.signal,
          headers: { Range: "bytes=0-1023" },
          credentials: "omit",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const reader = response.body!.getReader();
        await reader.read();
        await reader.cancel();
        results.push(`${path}: OK`);
      } catch (error) {
        results.push(`${path}: ${String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    if (results.some((entry) => !entry.endsWith(": OK")))
      throw new Error(results.join("; "));
  });
});
