import { PaperSemanticIndexer } from "./paperSemanticIndexer";
import { PaperSemanticRef, PaperSemanticSourceProvider } from "./types";

interface ZoteroNotifierLike {
  registerObserver(
    observer: { notify: ZoteroPaperIndexNotifier["notify"] },
    types: string[],
    id: string,
  ): string;
  unregisterObserver(id: string): void;
}

export interface ZoteroPaperIndexNotifierOptions {
  debounceMs?: number;
  notifier?: ZoteroNotifierLike;
  userLibraryID?: number;
  onError?: (error: Error) => void;
}

export class ZoteroPaperIndexNotifier {
  private readonly pending = new Map<string, PaperSemanticRef>();
  private readonly notifier: ZoteroNotifierLike;
  private readonly userLibraryID: number;
  private readonly debounceMs: number;
  private readonly onError: (error: Error) => void;
  private observerID?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private reconcileDeletes = false;
  private failurePasses = 0;
  private lifecycle = 0;
  private flushing?: Promise<void>;

  constructor(
    private readonly indexer: PaperSemanticIndexer,
    private readonly sourceProvider: PaperSemanticSourceProvider,
    options: ZoteroPaperIndexNotifierOptions = {},
  ) {
    this.notifier =
      options.notifier || (Zotero.Notifier as unknown as ZoteroNotifierLike);
    this.userLibraryID = options.userLibraryID || Zotero.Libraries.userLibraryID;
    this.debounceMs = Math.max(0, options.debounceMs ?? 250);
    this.onError = options.onError || defaultErrorHandler;
  }

  register(): void {
    if (this.observerID) return;
    this.observerID = this.notifier.registerObserver(
      { notify: this.notify.bind(this) },
      ["item"],
      "zaichat-paper-semantic-index",
    );
  }

  unregister(): void {
    this.lifecycle++;
    this.failurePasses = 0;
    if (this.observerID) this.notifier.unregisterObserver(this.observerID);
    this.observerID = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.reconcileDeletes = false;
  }

  async notify(
    event: string,
    type: string,
    ids: Array<number | string>,
    extraData: Record<string, unknown> = {},
  ): Promise<void> {
    if (type !== "item" || !SUPPORTED_EVENTS.has(event)) return;
    for (const value of ids) {
      const itemID = Number(value);
      let ref: PaperSemanticRef | null = null;
      if (event !== "delete" && Number.isInteger(itemID) && itemID > 0)
        ref = await this.sourceProvider.getPaperRefByItemID(itemID);
      ref ||= refFromExtraData(extraData, value);
      if (ref?.libraryID === this.userLibraryID) this.pending.set(refKey(ref), ref);
      else if (event === "delete") this.reconcileDeletes = true;
    }
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const task = this.flushPending();
    this.flushing = task;
    try {
      await task;
    } finally {
      this.flushing = undefined;
    }
  }

  private async flushPending(): Promise<void> {
    const lifecycle = this.lifecycle;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const refs = [...this.pending.values()];
    this.pending.clear();
    const errors: unknown[] = [];
    for (const ref of refs) {
      if (lifecycle !== this.lifecycle) return;
      try {
        await this.indexer.synchronizePaper(ref);
      } catch (error) {
        if (lifecycle !== this.lifecycle) return;
        this.pending.set(refKey(ref), ref);
        errors.push(error);
      }
    }
    if (this.reconcileDeletes) {
      this.reconcileDeletes = false;
      try {
        await this.indexer.requestDeleteReconciliation();
      } catch (error) {
        this.reconcileDeletes = true;
        errors.push(error);
      }
    }
    if (lifecycle !== this.lifecycle) return;
    if (errors.length) {
      this.failurePasses++;
      if (this.failurePasses === 1) this.scheduleFlush();
      throw new Error(
        `Semantic synchronization failed for ${errors.length} operations; pending work retained`,
        { cause: errors[0] },
      );
    }
    this.failurePasses = 0;
    if (this.pending.size) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error) =>
        this.onError(error instanceof Error ? error : new Error(String(error))),
      );
    }, this.debounceMs);
  }
}

const SUPPORTED_EVENTS = new Set(["add", "modify", "delete", "trash", "refresh"]);

function refFromExtraData(
  extraData: Record<string, unknown>,
  id: number | string,
): PaperSemanticRef | null {
  const keyed = extraData[String(id)];
  const data = isRecord(keyed) ? keyed : extraData;
  const libraryID = Number(data.libraryID);
  const itemKey = String(data.key || data.itemKey || "");
  return Number.isInteger(libraryID) && libraryID > 0 && itemKey
    ? { libraryID, itemKey }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refKey(ref: PaperSemanticRef): string {
  return `${ref.libraryID}:${ref.itemKey}`;
}

function defaultErrorHandler(error: Error): void {
  const safe = new Error(`Paper semantic notifier failed (${error.name})`);
  Zotero.logError(safe);
}
