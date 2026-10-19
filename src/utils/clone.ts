/** Clone JSON-serializable persisted state without relying on structuredClone,
 * which is not exposed in Zotero's bootstrap sandbox. */
export function cloneJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
