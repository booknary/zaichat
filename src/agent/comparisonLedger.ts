import { SourceReference } from "../core/types";

export interface ComparisonRow {
  sourceID: string;
  quote: string;
  metric: string;
  value: number;
  unit: string;
  scope: string;
  measurementBasis?:
    | "observed"
    | "compiled"
    | "inferred"
    | "total_sample"
    | "trait_nonmissing"
    | "unspecified";
}

export const comparisonRequested = (query: string) =>
  /排序|从多到少|从少到多|降序|升序|\brank(?:ed|ing)?\b|\bsort(?:ed|ing)?\b/iu.test(
    query,
  );

const normalized = (text: string) => text.replace(/\s+/gu, " ").trim();
export function evidenceNumbers(text: string): number[] {
  return (
    text.match(
      /(?<![\w.])[-+]?(?:\d{1,3}(?:[, \u00a0\u202f]\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?(?![\w.])/gu,
    ) || []
  ).map((value) => Number(value.replace(/[, \u00a0\u202f]/gu, "")));
}
const groupKey = (row: ComparisonRow) =>
  JSON.stringify([
    row.metric.trim().toLowerCase(),
    row.unit.trim().toLowerCase(),
    row.measurementBasis || row.scope,
  ]);

/** Run-local, bounded, source-backed records; never a learned summary. */
export class ComparisonLedger {
  private rows = new Map<string, ComparisonRow & { title: string }>();
  private ascending = false;

  clear() {
    this.rows.clear();
  }

  record(
    rows: ComparisonRow[],
    sources: Map<string, SourceReference>,
    ascending: boolean,
  ) {
    if (
      !Array.isArray(rows) ||
      !rows.length ||
      rows.length > 8 ||
      typeof ascending !== "boolean"
    )
      throw new Error("Supply 1–8 comparison records and an explicit sort direction");
    const next = new Map(this.rows);
    for (const row of rows) {
      if (
        !row ||
        typeof row.sourceID !== "string" ||
        typeof row.quote !== "string" ||
        row.quote.trim().length < 12 ||
        row.quote.length > 500 ||
        ![row.metric, row.unit, row.scope].every(
          (value) =>
            typeof value === "string" && value.trim().length > 0 && value.length <= 150,
        )
      )
        throw new Error("Invalid comparison fields or quote length");
      const source = sources.get(row.sourceID);
      if (
        !source?.snippet ||
        !normalized(source.snippet).includes(normalized(row.quote))
      )
        throw new Error("Comparison quote must occur in a current evidence source");
      if (
        row.measurementBasis &&
        ![
          "observed",
          "compiled",
          "inferred",
          "total_sample",
          "trait_nonmissing",
          "unspecified",
        ].includes(row.measurementBasis)
      )
        throw new Error("Invalid measurement basis");
      const numbers = evidenceNumbers(row.quote);
      if (!Number.isFinite(row.value) || row.value < 0 || !numbers.includes(row.value))
        throw new Error(
          "Comparison value must be an explicit number in the quote; no inferred counts or conversions",
        );
      const key = JSON.stringify([
        source.item.libraryID,
        source.item.itemKey,
        groupKey(row),
      ]);
      next.set(key, { ...row, title: source.label });
    }
    if (next.size > 20 || JSON.stringify([...next.values()]).length > 8000)
      throw new Error(
        "Comparison ledger limit reached (20 records / 8000 characters); finish a partial ranking",
      );
    this.rows = next;
    this.ascending = ascending;
    return this.snapshot();
  }

  snapshot() {
    return [...this.rows.values()].sort(
      (a, b) =>
        groupKey(a).localeCompare(groupKey(b)) ||
        (this.ascending ? a.value - b.value : b.value - a.value),
    );
  }

  markdown() {
    const escape = (value: string) =>
      value.replace(/[\\|`*_<>[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
    const rows = this.snapshot();
    if (!rows.length) return "";
    let text = "\n\n### 有原文支持的数值（分组排序，非完整文库排名）";
    let previous = "";
    const labels = {
      observed: "直接测量",
      compiled: "文献汇编",
      inferred: "推断覆盖",
      total_sample: "研究总样本",
      trait_nonmissing: "该性状有效样本",
      unspecified: "口径未明确",
    };
    for (const row of rows) {
      const key = groupKey(row);
      if (key !== previous) {
        text += `\n\n#### ${escape(row.metric)} · ${escape(row.unit)} · ${escape(row.measurementBasis ? labels[row.measurementBasis] : row.scope)}（${this.ascending ? "升序" : "降序"}）\n\n| 文献 | 数值 | 范围说明 |\n| --- | ---: | --- |`;
        previous = key;
      }
      text += `\n| ${escape(row.title)} [${row.sourceID}] | ${row.value} | ${escape(row.scope)} |`;
    }
    return text;
  }
}
