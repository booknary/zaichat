import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { groupSources, evidenceGroups } from "../src/ui/sourceGroups";
import { SourceCard } from "../src/ui/ChatApp";

const source = {
  sourceID: "src-a",
  item: { libraryID: 1, itemKey: "PAPER001" },
  label: "One paper",
  snippet: "First evidence",
  field: "fulltext" as const,
  attachment: { libraryID: 1, itemKey: "PDF00001" },
};
it("groups by library and paper while retaining distinct evidence IDs", () => {
  const sources = [
    source,
    { ...source, sourceID: "src-b" },
    { ...source, sourceID: "src-c", snippet: "Second evidence" },
  ];
  expect(groupSources(sources)).toHaveLength(1);
  expect(evidenceGroups(sources)).toHaveLength(2);
  const html = renderToStaticMarkup(
    <SourceCard
      source={source}
      sources={sources}
      anchorPrefix="test-"
      onLocate={() => {}}
      onOpen={() => {}}
    />,
  );
  expect(html.match(/One paper/g)).toHaveLength(1);
  expect(html.match(/First evidence/g)).toHaveLength(1);
  expect(html).toContain('id="test-src-b"');
  expect(html).toContain('id="test-src-c"');
  expect(html).not.toMatch(/<details[^>]* open/);
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(
    groupSources([source, { ...source, item: { libraryID: 2, itemKey: "PAPER001" } }]),
  ).toHaveLength(2);
  expect(
    evidenceGroups([
      source,
      { ...source, attachment: { libraryID: 1, itemKey: "PDF00002" } },
    ]),
  ).toHaveLength(2);
  const multiple = renderToStaticMarkup(
    <SourceCard
      source={source}
      sources={[
        source,
        {
          ...source,
          sourceID: "src-si",
          attachment: {
            libraryID: 1,
            itemKey: "SI000001",
            title: "Supplementary Information",
          },
        },
      ]}
      onLocate={() => {}}
      onOpen={() => {}}
    />,
  );
  expect(multiple).toContain("Supplementary Information");
  expect(multiple.match(/打开此附件/g)).toHaveLength(2);
});
