import { it, expect, vi } from "vitest";
import { ToolRegistry } from "../src/agent/toolRegistry";

const previousItem = { libraryID: 1, itemKey: "PAPER001" };
const context = () => ({
  conversationID: "test",
  previousItems: [previousItem],
  context: {
    refs: { items: [], attachments: [], notes: [], annotations: [], collections: [] },
  },
  maxAttachments: 8,
  evidenceBudget: { remainingChars: 60000 },
});

it("rejects unresolved attachments without searching or claiming no matches", async () => {
  const readSnippets = vi.fn();
  const registry = new ToolRegistry({ readSnippets } as any);
  const result = await registry.execute(
    {
      id: "r",
      name: "read_attachment_snippets",
      arguments: {
        attachments: [{ libraryID: 1, itemKey: "OLDATT01" }],
        terms: ["method"],
      },
    },
    context() as any,
  );
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("attachment-unresolved");
  expect(readSnippets).not.toHaveBeenCalled();
});

it("only resolves prior paper references when explicitly requested", async () => {
  const getItems = vi.fn(async () => ({ items: [], sources: [] }));
  const registry = new ToolRegistry({ getItems } as any);
  await registry.execute(
    { id: "c1", name: "get_current_context", arguments: {} },
    context() as any,
  );
  expect(getItems).not.toHaveBeenCalled();
  await registry.execute(
    { id: "c2", name: "get_current_context", arguments: { includePrevious: true } },
    context() as any,
  );
  expect(getItems).toHaveBeenCalledWith([previousItem]);
});

it("rejects a confident finish with no current source evidence", async () => {
  const registry = new ToolRegistry({} as any);
  const result = await registry.execute(
    {
      id: "f",
      name: "finish_answer",
      arguments: {
        answer: "The method is absent.",
        sourceIDs: [],
        evidenceInsufficient: false,
      },
    },
    context() as any,
  );
  expect(result.ok).toBe(false);
});
