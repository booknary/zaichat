import { describe, expect, it } from "vitest";
import {
  isAnnotationItem,
  isAttachmentItem,
  isNoteItem,
  isRegularItem,
} from "../src/host/itemTypes";

describe("Zotero item type compatibility", () => {
  it("accepts cross-sandbox boolean type flags without calling them", () => {
    const attachment = { isAttachment: true, isRegularItem: false } as any;
    expect(isAttachmentItem(attachment)).toBe(true);
    expect(isRegularItem(attachment)).toBe(false);
  });

  it("accepts the normal Zotero predicate methods", () => {
    expect(isNoteItem({ isNote: () => true } as any)).toBe(true);
    expect(isAnnotationItem({ isAnnotation: () => true } as any)).toBe(true);
    expect(isRegularItem({ isRegularItem: () => true } as any)).toBe(true);
  });

  it("does not classify child item types as regular when only type flags exist", () => {
    expect(isRegularItem({ isAttachment: true } as any)).toBe(false);
    expect(isRegularItem({ isNote: true } as any)).toBe(false);
    expect(isRegularItem({ isAnnotation: true } as any)).toBe(false);
  });
});
