const BLOCKED_PROTOCOL = /^(?:javascript|data|vbscript):/i;

export function stripDangerousHTML(value: string): string {
  return value
    .replace(
      /<\/?(?:script|style|iframe|object|embed|form|input|button|svg|math)[^>]*>/gi,
      "",
    )
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\s(?:href|src)\s*=\s*(["'])\s*(?:javascript|data|vbscript):[\s\S]*?\1/gi,
      "",
    );
}

export function sanitizeNoteHTML(value: string): string {
  const clean = stripDangerousHTML(value.trim());
  return clean || "<p></p>";
}

export function sanitizeMarkdown(value: string): string {
  return (
    stripDangerousHTML(value)
      // Recognize tag syntax, not arbitrary text between statistical < and > signs.
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(
        /<\/?[a-z][a-z0-9:-]*(?:\s+[a-z_:][a-z0-9_:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/gi,
        "",
      )
      .replace(/\]\(([^)]+)\)/g, (whole, url: string) =>
        BLOCKED_PROTOCOL.test(url.trim()) ? "](#)" : whole,
      )
  );
}

export function sanitizeTag(value: string): string | undefined {
  const normalized = value
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .trim()
    .replace(/\s+/g, " ");
  return normalized && normalized.length <= 255 ? normalized : undefined;
}

export function redactSecrets(value: string, secrets: string[]): string {
  return secrets
    .filter(Boolean)
    .reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
}
