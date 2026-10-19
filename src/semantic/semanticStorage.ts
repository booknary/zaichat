export interface SemanticStorageLayout {
  indexRoot: string;
  indexDatabasePath: string;
  artifactRoot: string;
}

export function resolveSemanticStorage(
  profileDirectory: string,
  customArtifactRoot = "",
  join: (...parts: string[]) => string = joinPath,
): SemanticStorageLayout {
  const profile = profileDirectory.trim();
  if (!isAbsolutePath(profile))
    throw new Error("Zotero profile directory must be an absolute path");
  const custom = customArtifactRoot.trim();
  if (custom && !isAbsolutePath(custom))
    throw new Error("Custom semantic model directory must be an absolute path");
  const indexRoot = join(profile, "zaichat", "semantic");
  const artifactRoot = custom || join(profile, "zaichat", "semantic-artifacts");
  if (custom && isFileSystemRoot(custom))
    throw new Error("Custom semantic model directory must not be a filesystem root");
  if (
    pathsOverlap(indexRoot, artifactRoot) ||
    pathsOverlap(join(profile, "zaichat", "semantic-models"), artifactRoot)
  )
    throw new Error("Semantic model and index directories must not overlap");
  return {
    indexRoot,
    indexDatabasePath: join(indexRoot, "index.sqlite"),
    artifactRoot,
  };
}

function isAbsolutePath(value: string): boolean {
  return (
    /^[a-z]:[\\/]/i.test(value) ||
    /^\\\\[^\\]+[\\][^\\]+/.test(value) ||
    value.startsWith("/")
  );
}

function isFileSystemRoot(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" || /^[a-z]:$/i.test(normalized);
}

function pathsOverlap(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
  const first = normalize(left);
  const second = normalize(right);
  return (
    first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`)
  );
}

function joinPath(...parts: string[]): string {
  const separator = parts[0]?.includes("\\") ? "\\" : "/";
  const values = parts.filter(Boolean);
  const first = values[0] || "";
  let result = first.replace(/[\\/]+$/, "");
  if (!result && first.startsWith("/")) result = "/";
  for (const part of values.slice(1)) {
    const value = part.replace(/^[\\/]+|[\\/]+$/g, "");
    result = result.endsWith(separator)
      ? `${result}${value}`
      : `${result}${separator}${value}`;
  }
  return result;
}
