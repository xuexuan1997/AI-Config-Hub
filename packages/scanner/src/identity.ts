import { createHash } from "node:crypto";

export function stableId(prefix: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("ai-config-hub:identity:v1\0").update(prefix).update("\0");
  for (const part of parts)
    hash
      .update(String(Buffer.byteLength(part)))
      .update(":")
      .update(part);
  return `${prefix}:${hash.digest("hex")}`;
}
