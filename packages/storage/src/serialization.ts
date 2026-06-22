export interface ValueParser<T> {
  parse(value: unknown): T;
}

const sensitiveKey =
  /(?:token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization|cookie|credential)/i;
const sensitiveContainer = /^(?:env|environment|headers|http_headers|query)$/i;
const embeddedSecret =
  /(?:^|\s)(?:bearer\s+\S+|--?(?:token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization|cookie|credential)(?:=|\s+)\S+)/i;

function unsafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.username !== "" ||
      url.password !== "" ||
      [...url.searchParams.keys()].some((key) => sensitiveKey.test(key))
    );
  } catch {
    return false;
  }
}

export function assertSecretSafeJson(value: unknown): void {
  const active = new Set<object>();
  function visit(current: unknown, key?: string, forced = false): void {
    if (typeof current === "string") {
      if (
        forced ||
        (key !== undefined && sensitiveKey.test(key)) ||
        embeddedSecret.test(current) ||
        unsafeUrl(current)
      ) {
        throw new TypeError(
          `Secret-bearing literal cannot be persisted${key === undefined ? "" : ` at ${key}`}`,
        );
      }
      return;
    }
    if (typeof current !== "object" || current === null) return;
    if (active.has(current)) throw new TypeError("Cyclic JSON cannot be persisted");
    active.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, key, forced);
    } else {
      for (const [childKey, child] of Object.entries(current)) {
        const secretRepresentation =
          typeof child === "object" &&
          child !== null &&
          ("digest" in child || "expression" in child || "$redacted" in child);
        visit(
          child,
          childKey,
          !secretRepresentation && (forced || sensitiveContainer.test(key ?? "")),
        );
      }
    }
    active.delete(current);
  }
  visit(value);
}

export function serializeJson(value: unknown): string {
  assertSecretSafeJson(value);
  return JSON.stringify(value);
}

export function parseJson<T>(schema: ValueParser<T>, text: string): T {
  return schema.parse(JSON.parse(text) as unknown);
}
