import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MessageText } from "../src/ui/MessageText";
import { SourceCard } from "../src/ui/ChatApp";

const source = {
  sourceID: "src-long-verified-reference",
  item: { libraryID: 1, itemKey: "TEST0001" },
  label: "Synthetic paper",
  snippet: "Bounded evidence",
};

it("removes labeled citation wrappers but preserves code examples", () => {
  const html = renderToStaticMarkup(
    <MessageText
      sources={[source]}
      text={`[sourceID: ${source.sourceID}] [sourceID: [src-forged]]\n\`[sourceID: src-example]\``}
    />,
  );
  expect(html).toContain(">[1]</button>");
  expect(html).toContain("来源不可用");
  expect(html).not.toContain(`sourceID: ${source.sourceID}`);
  expect(html).toContain("<code>[sourceID: src-example]</code>");
});

it("renders aligned comparison tables with citations and literal pipes", () => {
  const html = renderToStaticMarkup(
    <MessageText
      sources={[source]}
      text={
        "| Paper | Evidence | Count |\n| :--- | :---: | ---: |\n| **Title** | [src-long-verified-reference] | 2 |\n| a\\|b | `x|y` | 3 |\n| short |\n\nAfter table"
      }
    />,
  );
  expect(html).toContain("<table");
  expect(html.match(/<td /g)).toHaveLength(9);
  expect(html).toContain("text-align:center");
  expect(html).toContain("text-align:right");
  expect(html).toContain("<strong>Title</strong>");
  expect(html).toContain(">[1]</button>");
  expect(html).toContain("a|b");
  expect(html).toContain("<code>x|y</code>");
  expect(html).not.toContain(":---");
  expect(html).toContain('</table></div><div class="zaichat-text-space"');
  expect(html).toContain("After table");
});

it("keeps incomplete tables readable until a valid delimiter arrives", () => {
  for (const text of ["A | B\n-- |", "A | B\n--- | --- | ---"]) {
    const html = renderToStaticMarkup(<MessageText text={text} />);
    expect(html).not.toContain("<table");
    expect(html).toContain("A | B");
  }
});

it("preserves fenced code structure and does not interpret its content", () => {
  const html = renderToStaticMarkup(
    <MessageText
      text={
        "````md\n  **literal**\n\n```\n<script>x</script>\n````\n~~~txt\n  last\n\nline"
      }
    />,
  );
  expect(html.match(/<pre /g)).toHaveLength(2);
  expect(html).toContain(
    "<code>  **literal**\n\n```\n&lt;script&gt;x&lt;/script&gt;</code>",
  );
  expect(html).toContain("<code>  last\n\nline</code>");
  expect(html).not.toContain("<strong>");
  expect(html).not.toContain("<script>");
});

it("supports indented plus lists and strike without interpreting escaped markers", () => {
  const html = renderToStaticMarkup(
    <MessageText
      text={"+ Parent\n  - ~~old~~ **new**\n\\# literal heading\n\\~literal\\~"}
    />,
  );
  expect(html).toContain("margin-inline-start:1em");
  expect(html).toContain("<del>old</del>");
  expect(html).toContain("<strong>new</strong>");
  expect(html).toContain("# literal heading");
  expect(html).toContain("~literal~");
  expect(html).not.toContain('role="heading"');
});

it("renders only whitelisted citations as compact navigation buttons", () => {
  const html = renderToStaticMarkup(
    <MessageText
      text="Claim [src-long-verified-reference] and [src-forged]."
      sources={[source]}
      onSource={() => {}}
    />,
  );
  expect(html).toContain("zaichat-citation-button");
  expect(html).toContain(">[1]</button>");
  expect(html).not.toContain("src-long-verified-reference");
  expect(html).not.toContain("src-forged");
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain("来源不可用");
});

it("keeps evidence collapsed while retaining source actions", () => {
  const html = renderToStaticMarkup(
    <SourceCard source={source} onLocate={() => {}} onOpen={() => {}} />,
  );
  expect(html).toContain("Synthetic paper");
  expect(html).toContain("zaichat-source-entry");
  expect(html).not.toContain("zaichat-card");
  expect(html).not.toContain("zaichat-message-bubble");
  expect(html).toContain("定位");
  expect(html).toContain("打开");
  expect(html).toContain('<details class="zaichat-source-evidence">');
  expect(html).not.toMatch(/<details[^>]*\bopen/);
  expect(html).toContain("Bounded evidence");
});

it("renders bare and parenthesized verified IDs from existing conversations", () => {
  const html = renderToStaticMarkup(
    <MessageText text={`(${source.sourceID}) and src-unknown`} sources={[source]} />,
  );
  expect(html).toContain("zaichat-citation-button");
  expect(html).not.toContain(source.sourceID);
  expect(html).toContain("来源不可用");
});

it("renders headings, emphasis, lists and code without executing HTML", () => {
  const html = renderToStaticMarkup(
    <MessageText
      text={"## 方法\n**结论**\n- P<0.01\n`omega>1`\n<script>alert(1)</script>"}
    />,
  );
  expect(html).toContain('role="heading"');
  expect(html).toContain("<strong>结论</strong>");
  expect(html).toContain("zaichat-text-list");
  expect(html).toContain("P&lt;0.01");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

it("preserves code text and incomplete streaming markup", () => {
  const html = renderToStaticMarkup(
    <MessageText text={'```js\nconst x = "<div>";\n```\n**unfinished'} />,
  );
  expect(html).toContain("zaichat-code-line");
  expect(html).toContain("**unfinished");
  expect(html).not.toContain('<div>";');
});

it("renders journal italics inside a bold bibliography entry without stray stars", () => {
  const html = renderToStaticMarkup(
    <MessageText
      text={'**Author (2020). "Synthetic title." *Current Biology*, 30(3).**'}
    />,
  );
  expect(html).toContain("<strong>Author (2020).");
  expect(html).toContain("<em>Current Biology</em>");
  expect(html).toContain("30(3).</strong>");
  expect(html).not.toContain("*");
});

it("supports italic, combined and underscore emphasis while preserving literal markers", () => {
  const html = renderToStaticMarkup(
    <MessageText
      text={
        "*斜体* ***粗斜体*** __粗体__ _italic_ gene_name `**literal**` \\*literal\\* 2 * 3\n**unfinished"
      }
    />,
  );
  expect(html).toContain("<em>斜体</em>");
  expect(html).toContain("<strong><em>粗斜体</em></strong>");
  expect(html).toContain("<strong>粗体</strong>");
  expect(html).toContain("<em>italic</em>");
  expect(html).toContain("gene_name");
  expect(html).toContain("<code>**literal**</code>");
  expect(html).toContain("*literal* 2 * 3");
  expect(html).toContain("**unfinished");
});
