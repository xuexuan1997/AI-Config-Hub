import { createHash } from "node:crypto";

import type { SecretAwareString } from "@ai-config-hub/core";
import { ContentHashSchema } from "@ai-config-hub/shared";

const sensitiveKey =
  /(?:token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization|cookie|credential)/i;
const sensitiveContainer = /^(?:env|headers|http_headers|query)$/i;
const environmentReference = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
const embeddedSecret =
  /(?:^|\s)(?:bearer\s+\S+|--?(?:token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization|cookie|credential)(?:=|\s+)\S+)/i;

function digest(value: string) {
  return ContentHashSchema.parse(
    `sha256:${createHash("sha256").update("ai-config-hub:secret:v1\0").update(value).digest("hex")}`,
  );
}

function urlContainsSecret(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return true;
    return [...url.searchParams.keys()].some((key) => sensitiveKey.test(key));
  } catch {
    return false;
  }
}

export function toSecretAwareString(value: string, key?: string): SecretAwareString {
  if (environmentReference.test(value)) {
    return { kind: "reference", expression: value, deployable: true };
  }
  if (
    (key !== undefined && sensitiveKey.test(key)) ||
    embeddedSecret.test(value) ||
    urlContainsSecret(value)
  ) {
    return { kind: "redacted", digest: digest(value), deployable: false };
  }
  return { kind: "literal", value, deployable: true };
}

export interface RedactedJsonValue {
  readonly $redacted: ReturnType<typeof digest>;
}

export function redactStructuredValue(value: unknown): unknown {
  const active = new Set<object>();

  function redact(current: unknown, key?: string, forceSensitive = false): unknown {
    if (typeof current === "string") {
      const secret =
        forceSensitive ||
        (key !== undefined && sensitiveKey.test(key)) ||
        urlContainsSecret(current);
      return secret ? ({ $redacted: digest(current) } satisfies RedactedJsonValue) : current;
    }
    if (typeof current !== "object" || current === null) return current;
    if (active.has(current)) throw new TypeError("Cannot redact a cyclic value");
    active.add(current);
    let result: unknown;
    if (Array.isArray(current)) {
      result = current.map((item) => redact(item, key, forceSensitive));
    } else {
      result = Object.fromEntries(
        Object.entries(current).map(([childKey, child]) => [
          childKey,
          redact(
            child,
            childKey,
            forceSensitive ||
              sensitiveContainer.test(key ?? "") ||
              sensitiveContainer.test(childKey),
          ),
        ]),
      );
    }
    active.delete(current);
    return result;
  }

  return redact(value);
}
