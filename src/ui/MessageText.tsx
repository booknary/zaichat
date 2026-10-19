import React from "react";
import { SourceReference } from "../core/types";
import { useMenuText, createMenuTranslator } from "./menuLocale";

// Render basic Markdown as React text, never raw HTML.
function renderInline(
  text: string,
  sources: SourceReference[],
  onSource?: (source: SourceReference) => void,
  t = createMenuTranslator("zh-CN"),
): React.ReactNode[] {
  return text
    .split(
      /(\\[\\*_`|~[\]{}()#+.!>-]|`[^`\n]+`|\*\*\*(?=\S)[^\n]+?\*\*\*(?!\*)|\*\*(?=\S)[^\n]+?\*\*(?!\*)|~~(?=\S)[^\n]+?~~|(?<!\*)\*(?!\*)(?=\S)[^*\n]*?\S\*(?!\*)|(?<![\w_])__(?=\S)[^\n]+?__(?![\w_])|(?<![\w_])_(?!_)(?=\S)[^_\n]*?\S_(?![\w_])|\[sourceID:\s*\[?src-[a-zA-Z0-9_-]+\]?\]|\[src-[a-zA-Z0-9_-]+\]|\bsrc-[a-zA-Z0-9_-]+)/g,
    )
    .map((part) =>
      part.replace(/^\[sourceID:\s*\[?(src-[a-zA-Z0-9_-]+)\]?\]$/u, "[$1]"),
    )
    .map((part) => (/^src-[a-zA-Z0-9_-]+$/.test(part) ? `[${part}]` : part))
    .map((part, index) =>
      /^\\[\\*_`|~[\]{}()#+.!>-]$/.test(part) ? (
        part.slice(1)
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : part.startsWith("~~") && part.endsWith("~~") ? (
        <del key={index}>{renderInline(part.slice(2, -2), sources, onSource, t)}</del>
      ) : part.length > 6 && part.startsWith("***") && part.endsWith("***") ? (
        <strong key={index}>
          <em>{renderInline(part.slice(3, -3), sources, onSource, t)}</em>
        </strong>
      ) : part.length > 4 &&
        ((part.startsWith("**") && part.endsWith("**")) ||
          (part.startsWith("__") && part.endsWith("__"))) ? (
        <strong key={index}>
          {renderInline(part.slice(2, -2), sources, onSource, t)}
        </strong>
      ) : part.length > 2 &&
        ((part.startsWith("*") && !part.startsWith("**") && part.endsWith("*")) ||
          (part.startsWith("_") && !part.startsWith("__") && part.endsWith("_"))) ? (
        <em key={index}>{renderInline(part.slice(1, -1), sources, onSource, t)}</em>
      ) : /^\[src-/.test(part) ? (
        sources.some((source) => source.sourceID === part.slice(1, -1)) ? (
          <button
            key={index}
            className="zaichat-citation-button"
            title={
              sources.find((source) => source.sourceID === part.slice(1, -1))!.label
            }
            onClick={() =>
              onSource?.(
                sources.find((source) => source.sourceID === part.slice(1, -1))!,
              )
            }
          >
            [{sources.findIndex((source) => source.sourceID === part.slice(1, -1)) + 1}]
          </button>
        ) : (
          <span
            key={index}
            title={t("Source is not among this answer's verified citations")}
          >
            {t("[Source unavailable]")}
          </span>
        )
      ) : (
        part
      ),
    );
}

// Split only structural pipes; escaped pipes and code-span contents stay literal.
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "",
    codeTicks = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && i + 1 < line.length) {
      cell += line[i] + line[++i];
    } else if (line[i] === "`") {
      let end = i + 1;
      while (line[end] === "`") end++;
      const count = end - i;
      if (!codeTicks) codeTicks = count;
      else if (codeTicks === count) codeTicks = 0;
      cell += line.slice(i, end);
      i = end - 1;
    } else if (line[i] === "|" && !codeTicks) {
      cells.push(cell.trim());
      cell = "";
    } else cell += line[i];
  }
  cells.push(cell.trim());
  if (line.trimStart().startsWith("|")) cells.shift();
  if (cells.length > 1 && cells.at(-1) === "" && line.trimEnd().endsWith("|"))
    cells.pop();
  return cells;
}

export function MessageText({
  text,
  sources = [],
  onSource,
}: {
  text: string;
  sources?: SourceReference[];
  onSource?: (source: SourceReference) => void;
}) {
  const t = useMenuText();
  const inline = (value: string) => renderInline(value, sources, onSource, t);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const code: string[] = [];
      const start = index;
      while (++index < lines.length) {
        const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[index]);
        if (
          closing &&
          closing[1][0] === fence[1][0] &&
          closing[1].length >= fence[1].length
        )
          break;
        code.push(lines[index]);
      }
      blocks.push(
        <pre key={start} className="zaichat-code-line" tabIndex={0}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const headers = line.includes("|") ? tableCells(line) : [];
    const separators = tableCells(lines[index + 1] || "");
    if (
      headers.length > 0 &&
      headers.length <= 128 &&
      headers.length === separators.length &&
      separators.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      const start = index;
      const rows: string[][] = [];
      index++;
      while (
        index + 1 < lines.length &&
        lines[index + 1].trim() &&
        lines[index + 1].includes("|")
      ) {
        rows.push(tableCells(lines[++index]));
      }
      const align = (column: number): "left" | "center" | "right" =>
        separators[column].endsWith(":")
          ? separators[column].startsWith(":")
            ? "center"
            : "right"
          : "left";
      blocks.push(
        <div
          key={start}
          className="zaichat-table-scroll"
          role="region"
          aria-label={t("Table; scroll horizontally")}
          tabIndex={0}
        >
          <table
            className="zaichat-text-table"
            style={{ minWidth: `${Math.min(720, headers.length * 140)}px` }}
          >
            <thead>
              <tr>
                {headers.map((header, column) => (
                  <th key={column} scope="col" style={{ textAlign: align(column) }}>
                    {inline(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {headers.map((_, column) => (
                    <td key={column} style={{ textAlign: align(column) }}>
                      {inline(row[column] || "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    blocks.push(
      (() => {
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        if (heading)
          return (
            <div
              key={index}
              role="heading"
              aria-level={heading[1].length}
              className="zaichat-text-heading"
            >
              {inline(heading[2])}
            </div>
          );
        if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line))
          return <div key={index} className="zaichat-text-rule" />;
        const list = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
        if (list)
          return (
            <div
              key={index}
              className="zaichat-text-list"
              style={{
                marginInlineStart: `${Math.min(6, list[1].replace(/\t/g, "    ").length / 2)}em`,
              }}
            >
              <span aria-hidden="true">
                {line.trim().match(/^\d+[.)]/)?.[0] || "•"}
              </span>
              <span>{inline(list[2])}</span>
            </div>
          );
        if (line.startsWith("> "))
          return (
            <div key={index} className="zaichat-text-quote">
              {inline(line.slice(2))}
            </div>
          );
        return (
          <div
            key={index}
            className={line ? "zaichat-text-line" : "zaichat-text-space"}
          >
            {inline(line)}
          </div>
        );
      })(),
    );
  }
  return <div className="zaichat-markdown">{blocks}</div>;
}
