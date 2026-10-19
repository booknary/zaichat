import { E5ModelID, e5ModelID } from "./modelCatalog";
import { SemanticDataManager } from "./semanticDataManager";

export class SemanticModelInstaller {
  private controller?: AbortController;
  private task?: Promise<void>;
  private pendingSelection?: E5ModelID;
  constructor(
    readonly activeModel: E5ModelID,
    private readonly create: (id: E5ModelID) => SemanticDataManager,
    private readonly saveSelection: (id: E5ModelID) => void,
    private readonly supported: () => boolean,
  ) {}

  get busy(): boolean {
    return Boolean(this.controller);
  }
  inspect(id: E5ModelID) {
    return this.create(e5ModelID(id)).inspect();
  }

  install(
    id: E5ModelID,
    confirmed: boolean,
    onProgress?: (received: number, total: number, file: string) => void,
  ): Promise<void> {
    if (!confirmed)
      return Promise.reject(new Error("Model installation requires confirmation"));
    if (this.busy)
      return Promise.reject(new Error("Another model operation is running"));
    if (!this.supported())
      return Promise.reject(new Error("This runtime supports Windows x64 only"));
    const target = this.create(e5ModelID(id));
    const controller = new AbortController();
    this.controller = controller;
    const operation = async () => {
      try {
        await target.installRequired(true, {
          startAfterInstall: false,
          signal: controller.signal,
          onProgress,
        });
        if (controller.signal.aborted) throw new Error("Model installation cancelled");
        onProgress?.(0, 0, "Checking encoder, dimensions and query/document vectors…");
        await target.probeRuntime();
        if (controller.signal.aborted) throw new Error("Model installation cancelled");
        this.saveSelection(id);
        this.pendingSelection = id;
      } finally {
        this.controller = undefined;
      }
    };
    this.task = operation();
    return this.task;
  }

  async deleteModel(id: E5ModelID, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error("Model deletion requires confirmation");
    if (this.busy) throw new Error("Another model operation is running");
    if (id === this.activeModel || id === this.pendingSelection)
      throw new Error(
        "Switch to another model and restart Zotero before deleting the active model",
      );
    this.controller = new AbortController();
    try {
      await this.create(e5ModelID(id)).deleteModel(true);
    } finally {
      this.controller = undefined;
    }
  }

  cancel(): void {
    this.controller?.abort();
  }
  async shutdown(): Promise<void> {
    this.cancel();
    // Installation errors are displayed by the preferences action, not rethrown on shutdown.
    await this.task?.catch(() => undefined);
  }
}
