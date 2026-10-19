import { describe, expect, it } from "vitest";
import { createModelFingerprint } from "../src/semantic/fingerprint";
import { SemanticRecordBuilder } from "../src/semantic/semanticRecordBuilder";

describe("SemanticRecordBuilder", () => {
  it("builds separate deterministic title, abstract, and tag records", async () => {
    const builder = new SemanticRecordBuilder();
    const source = {
      libraryID: 1,
      itemKey: "ABCD1234",
      title: "  Genome   novelty ",
      abstract: "<p>Two waves of innovation</p>",
      tags: ["Evolution", "evolution", " Genome "],
    };
    const first = await builder.buildPaper(source);
    const second = await builder.buildPaper(source);
    expect(first.map((record) => record.sourceField)).toEqual([
      "title",
      "abstract",
      "tags",
    ]);
    expect(first.map((record) => record.recordID)).toEqual([
      "paper:1:ABCD1234:title",
      "paper:1:ABCD1234:abstract",
      "paper:1:ABCD1234:tags",
    ]);
    expect(first[1].embeddingText).toBe("Abstract: Two waves of innovation");
    expect(first[2].embeddingText).toBe("Tags: Evolution; Genome");
    expect(first.map((record) => record.sourceHash)).toEqual(
      second.map((record) => record.sourceHash),
    );
  });

  it("changes only the hash for the field whose source changed", async () => {
    const builder = new SemanticRecordBuilder();
    const base = {
      libraryID: 1,
      itemKey: "ABCD1234",
      title: "Title",
      abstract: "First abstract",
      tags: ["tag"],
    };
    const before = await builder.buildPaper(base);
    const after = await builder.buildPaper({ ...base, abstract: "Second abstract" });
    expect(after[0].sourceHash).toBe(before[0].sourceHash);
    expect(after[1].sourceHash).not.toBe(before[1].sourceHash);
    expect(after[2].sourceHash).toBe(before[2].sourceHash);
  });

  it("does not create records for empty paper fields", async () => {
    const records = await new SemanticRecordBuilder().buildPaper({
      libraryID: 1,
      itemKey: "EMPTY123",
      title: "",
      abstract: " ",
      tags: [],
    });
    expect(records).toEqual([]);
  });

  it("records external abstract provenance without changing Zotero metadata", async () => {
    const records = await new SemanticRecordBuilder().buildPaper({
      libraryID: 1,
      itemKey: "ENRICHED",
      title: "A verified title",
      abstract: "A DOI-resolved public abstract",
      abstractSource: "openalex",
      tags: [],
    });
    expect(records.find((record) => record.sourceField === "title")?.sourceType).toBe(
      "zotero-item",
    );
    expect(
      records.find((record) => record.sourceField === "abstract")?.sourceType,
    ).toBe("openalex-work");
  });

  it("creates a stable model fingerprint that includes artifact identity", async () => {
    const input = {
      modelID: "intfloat/multilingual-e5-small",
      version: "revision-1",
      dimensions: 384,
      modelSHA256: "a".repeat(64),
      tokenizerSHA256: "b".repeat(64),
      pooling: "mean" as const,
      normalization: "l2" as const,
    };
    const first = await createModelFingerprint(input);
    const second = await createModelFingerprint(input);
    const changed = await createModelFingerprint({ ...input, version: "revision-2" });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("matches the release builder fingerprint for the validated model snapshot", async () => {
    const model = await createModelFingerprint({
      modelID: "intfloat/multilingual-e5-small",
      version: "0e60b8d9d2166d80387f86e3b48ec9ced55f4d15",
      dimensions: 384,
      modelSHA256: "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665",
      tokenizerSHA256:
        "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
      pooling: "mean",
      normalization: "l2",
    });
    expect(model.fingerprint).toBe(
      "479e1869a1750f0891d281561e4654afec1c58c7aaeddc48ac4302ffcbdd0bb3",
    );
  });
});
