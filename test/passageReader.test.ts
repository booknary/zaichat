import { describe, expect, it } from "vitest";
import { adjacentPassage, rankPassages } from "../src/retrieval/passageReader";

describe("bounded passage reading", () => {
  it("downweights dense reference lists and permits bounded extended windows", () => {
    const text =
      "1. Example, A. novel method. 2. Carter, B. novel method. 3. Smith, C. novel method. " +
      "x ".repeat(900) +
      "Methods. We applied the novel method to all samples. " +
      "The sample was measured. ".repeat(40);
    const [best] = rankPassages(text, ["novel method"], 1, 1400);
    expect(best.text).toContain("We applied");
    expect(best.end - best.start).toBeLessThanOrEqual(1400);
  });
  it("ends on a sentence boundary without losing query evidence", () => {
    const text =
      "Elevation was measured. " +
      "The site was cold. ".repeat(5) +
      "Unrelated tail continues for a long distance";
    const [passage] = rankPassages(text, ["elevation"], 1, 100);
    expect(passage.text.endsWith(".")).toBe(true);
    expect(passage.text).toContain("Elevation");
    expect(passage.end - passage.start).toBeLessThanOrEqual(100);
    expect(text.slice(passage.start, passage.end).trim()).toBe(passage.text);
  });
  it("prefers later multi-concept evidence over early generic hits", () => {
    const text =
      ("average library size. " + "x ".repeat(100)).repeat(20) +
      "The branch mean was compared using a t-test with body size.";
    const [best] = rankPassages(text, ["size", "branch", "mean", "t-test"], 1, 100);
    expect(best.text).toContain("t-test");
    expect(best.matchedTerms).toContain("branch");
  });
  it("can find evidence beyond the previous 200k prefix", () => {
    const text = "x ".repeat(120000) + "alpine elevation adaptation";
    expect(rankPassages(text, ["elevation"], 1)[0].start).toBeGreaterThan(200000);
  });
  it("respects word boundaries and does not fabricate missing evidence", () => {
    expect(
      rankPassages("bodyweight sizes averaging", ["body", "size", "average"]),
    ).toEqual([]);
  });
  it("excludes previously delivered spans and caps text length", () => {
    const text = "elevation " + "x ".repeat(500) + "elevation adaptation";
    const first = rankPassages(text, ["elevation"], 1, 100);
    const next = rankPassages(text, ["elevation"], 1, 100, first);
    expect(next[0].start).toBeGreaterThan(first[0].end);
    expect(next[0].text.length).toBeLessThanOrEqual(100);
    expect(rankPassages(text, ["elevation"], 1, 100, [...first, ...next])).toEqual([]);
  });
  it("uses original cache offsets despite whitespace normalization", () => {
    const text = "\n\nAn elevation\n\tadaptation result.";
    const [span] = rankPassages(text, ["elevation"]);
    expect(text.slice(span.start, span.end).replace(/\s+/g, " ").trim()).toBe(
      span.text,
    );
  });
  it("reads adjacent content within cache bounds without returning it twice", () => {
    const text = "a".repeat(500);
    const span = { start: 100, end: 200 };
    const next = adjacentPassage(text, span, "after", 80);
    expect(next[0]).toMatchObject({ start: 200, end: 280 });
    expect(adjacentPassage(text, span, "after", 80, next)).toEqual([]);
    expect(adjacentPassage(text, { start: 0, end: 80 }, "before")).toEqual([]);
    expect(adjacentPassage(text, { start: 420, end: 500 }, "after")).toEqual([]);
  });
});
