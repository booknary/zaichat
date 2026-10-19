import { describe, expect, it } from "vitest";

describe("Zotero startup", () => {
  it.skipIf(typeof Zotero === "undefined")("defines the ZaiChat instance", () => {
    expect((Zotero as any).ZaiChat).toBeTruthy();
  });
});
