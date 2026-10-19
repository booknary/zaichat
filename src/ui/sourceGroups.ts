import { SourceReference } from "../core/types";

export function groupSources(sources: SourceReference[]) {
  const groups = new Map<string, SourceReference[]>();
  for (const source of sources) {
    const key = `${source.item.libraryID}:${source.item.itemKey}`;
    const group = groups.get(key) || [];
    group.push(source);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function evidenceGroups(sources: SourceReference[]) {
  const groups: Array<{ source: SourceReference; ids: string[] }> = [];
  for (const source of sources) {
    if (!source.snippet) continue;
    const duplicate = groups.find(
      (entry) =>
        entry.source.field === source.field &&
        entry.source.attachment?.libraryID === source.attachment?.libraryID &&
        entry.source.attachment?.itemKey === source.attachment?.itemKey &&
        entry.source.snippet === source.snippet,
    );
    if (duplicate) duplicate.ids.push(source.sourceID);
    else groups.push({ source, ids: [source.sourceID] });
  }
  return groups;
}
