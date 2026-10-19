export function createID(prefix: string): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return `${prefix}-${cryptoObject.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}
