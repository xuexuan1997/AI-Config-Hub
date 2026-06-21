import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;

export class ConfigParseError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line = 1, column = 1, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigParseError";
    this.line = line;
    this.column = column;
  }
}

export function assertBoundedDocument(text: string): void {
  if (new TextEncoder().encode(text).byteLength > MAX_DOCUMENT_BYTES) {
    throw new ConfigParseError("Configuration document exceeds the 4 MiB limit");
  }
}

export function assertBoundedValue(value: unknown): void {
  const active = new Set<object>();
  let nodes = 0;

  function visit(current: unknown, depth: number): void {
    nodes += 1;
    if (nodes > MAX_NODES) throw new ConfigParseError("Configuration contains too many values");
    if (depth > MAX_DEPTH) throw new ConfigParseError("Configuration nesting exceeds 64 levels");
    if (typeof current !== "object" || current === null) return;
    if (active.has(current)) throw new ConfigParseError("Configuration values cannot be cyclic");
    active.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
    } else {
      for (const item of Object.values(current)) visit(item, depth + 1);
    }
    active.delete(current);
  }

  visit(value, 0);
}

export function requireObject(value: unknown, format: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigParseError(`${format} configuration root must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseJsoncObject(text: string): Record<string, unknown> {
  assertBoundedDocument(text);
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  const first = errors[0];
  if (first !== undefined) {
    const prefix = text.slice(0, first.offset);
    const lines = prefix.split("\n");
    throw new ConfigParseError(
      `Invalid JSONC: ${printParseErrorCode(first.error)}`,
      lines.length,
      (lines.at(-1)?.length ?? 0) + 1,
    );
  }
  assertBoundedValue(value);
  return requireObject(value, "JSONC");
}

export function parseTomlObject(text: string): Record<string, unknown> {
  assertBoundedDocument(text);
  let value: unknown;
  try {
    value = parseToml(text);
  } catch (cause) {
    throw new ConfigParseError("Invalid TOML configuration", 1, 1, { cause });
  }
  assertBoundedValue(value);
  return requireObject(value, "TOML");
}
