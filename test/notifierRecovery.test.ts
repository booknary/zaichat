import { afterEach, describe, expect, it, vi } from "vitest";
import { ZoteroPaperIndexNotifier } from "../src/semantic/zoteroPaperIndexNotifier";

afterEach(() => vi.useRealTimers());
describe("incremental notification recovery", () => {
  it("continues after one failed paper and automatically retries only failed work", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let failed = false;
    const observer = new ZoteroPaperIndexNotifier(
      {
        synchronizePaper: async (ref: any) => {
          calls.push(ref.itemKey);
          if (ref.itemKey === "KEY1" && !failed) {
            failed = true;
            throw new Error("temporary worker failure");
          }
        },
      } as any,
      {
        getPaperRefByItemID: async (id: number) => ({
          libraryID: 1,
          itemKey: `KEY${id}`,
        }),
      } as any,
      { userLibraryID: 1, debounceMs: 100, notifier: {} as any, onError: vi.fn() },
    );
    await observer.notify("add", "item", [1, 2]);
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toEqual(["KEY1", "KEY2", "KEY1"]);
    observer.unregister();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds automatic retries and drops pending work on unload", async () => {
    vi.useFakeTimers();
    const synchronizePaper = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const observer = new ZoteroPaperIndexNotifier(
      { synchronizePaper } as any,
      { getPaperRefByItemID: async () => ({ libraryID: 1, itemKey: "KEY1" }) } as any,
      { userLibraryID: 1, debounceMs: 100, notifier: {} as any, onError: vi.fn() },
    );
    await observer.notify("add", "item", [1]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(synchronizePaper).toHaveBeenCalledTimes(2);
    observer.unregister();
    await observer.flush();
    expect(synchronizePaper).toHaveBeenCalledTimes(2);
  });
});
