import { expect, it } from "vitest";
import { classifyPassage } from "../src/retrieval/evidenceProvenance";
import { evidenceFactProblems } from "../src/agent/methodEvidence";

it.each(["Extended Data Fig. 8 |", "Supplementary Figure S3.", "Figure 2:"])(
  "ends bibliography provenance at a caption heading: %s",
  (heading) => {
    const quote = "Samples were imaged at three stages and gene modules were compared.";
    const text =
      "References\n1. Smith, A. A study of samples.\n" +
      heading +
      " Imaging results.\n" +
      quote;
    const at = text.indexOf(quote);
    const provenance = classifyPassage(text, at, text.length);
    expect(provenance).toMatchObject({ section: "figure-legend", basis: "heading" });
    expect(
      evidenceFactProblems(
        [
          {
            sourceID: "source",
            item: { libraryID: 1, itemKey: "SYNTH001" },
            label: "Synthetic",
            snippet: quote,
            provenance,
          },
        ],
        [
          {
            sourceID: "source",
            quote,
            fact: "The study imaged samples.",
            kind: "method",
          },
        ],
      ),
    ).toEqual([]);
  },
);
it.each([
  "Reporting Summary",
  "Acknowledgements",
  "Code availability",
  "Extended Data Table 2 | Cohort metadata",
])("ends stale references without certifying methods: %s", (heading) => {
  const text =
    "References\n1. Smith, A. Earlier paper.\n" +
    heading +
    "\nAnalysis used Toolkit version 7.";
  expect(
    classifyPassage(text, text.indexOf("Analysis used"), text.length).section,
  ).toBe("unknown");
});
it("keeps renewed bibliography and prose mentions conservative", () => {
  const text =
    "References\n1. Smith, A. Software.\n2. Jones, B. Extended Data Fig. 4 describes experiments.\nReporting Summary\nAnalysis used Toolkit.\nReferences\n3. Green, C. Manual.";
  expect(
    classifyPassage(text, text.indexOf("2. Jones"), text.indexOf("Reporting Summary"))
      .section,
  ).toBe("references");
  expect(classifyPassage(text, text.indexOf("3. Green"), text.length).section).toBe(
    "references",
  );
  expect(
    classifyPassage("We refer to Extended Data Fig. 2 for context.", 0, 44).section,
  ).toBe("unknown");
});
it("does not extend a prior heading across a mixed-section excerpt", () => {
  const text =
    "References\n1. Smith, A. Software.\nExtended Data Fig. 2 | Measured values.";
  expect(classifyPassage(text, text.indexOf("1. Smith"), text.length).section).toBe(
    "unknown",
  );
});

it("recognizes reporting boundaries with Windows line endings", () => {
  const text =
    "References\r\n1. Smith, A. Earlier analysis.\r\nReporting Summary\r\nSoftware and code\r\nAnalysis used Toolkit version 7.";
  expect(
    classifyPassage(text, text.indexOf("Analysis used"), text.length).section,
  ).toBe("unknown");
});
