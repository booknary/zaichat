describe("Local semantic subsystem", function () {
  it("starts the installed worker, validates the model, and activates an index", async function () {
    if (!Services.env.get("ZAICHAT_SEMANTIC_ARTIFACT_ROOT")) return;
    this.timeout(90000);
    const manager = (Zotero as any).ZaiChat?.data?.semanticManager;
    if (!manager) throw new Error("Semantic manager was not initialized");
    await manager.start();
    const deadline = Date.now() + 80000;
    let status = await manager.inspect();
    while (!["ready", "failed", "unavailable"].includes(status.subsystem.state)) {
      if (Date.now() >= deadline)
        throw new Error(`Semantic startup timed out in ${status.subsystem.state}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = await manager.inspect();
    }
    if (!status.runtime.verified || !status.model.verified)
      throw new Error(
        `Semantic artifacts were not verified: ${JSON.stringify(status)}`,
      );
    if (status.subsystem.state !== "ready")
      throw new Error(
        `Semantic subsystem did not become ready: ${JSON.stringify(status)}`,
      );
    if (!status.index.verified)
      throw new Error(
        `Semantic index root was not verified: ${JSON.stringify(status)}`,
      );
    const hits = await manager.searchPapers("query: 两次基因组创新 🧬", 10);
    if (!Array.isArray(hits))
      throw new Error("Semantic search did not return an array");
  });
});
