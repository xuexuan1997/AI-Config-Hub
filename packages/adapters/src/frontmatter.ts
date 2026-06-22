import { LineCounter, parseDocument } from "yaml";

import {
  assertBoundedDocument,
  assertBoundedValue,
  ConfigParseError,
  requireObject,
} from "./structured-config.js";

export { ConfigParseError } from "./structured-config.js";

export interface FrontmatterDocument {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly bodyStartLine: number;
}

export function parseFrontmatter(text: string): FrontmatterDocument {
  assertBoundedDocument(text);
  if (!text.startsWith("---\n") && text !== "---") {
    return { attributes: Object.freeze({}), body: text, bodyStartLine: 1 };
  }
  const lines = text.split("\n");
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex < 0) throw new ConfigParseError("Unclosed YAML frontmatter", 1, 1);

  const header = lines.slice(1, closingIndex).join("\n");
  const lineCounter = new LineCounter();
  const document = parseDocument(header, {
    lineCounter,
    schema: "core",
    uniqueKeys: true,
  });
  const issue = document.errors[0];
  if (issue !== undefined) {
    const position = lineCounter.linePos(issue.pos[0]);
    throw new ConfigParseError(issue.message, position.line + 1, position.col);
  }
  const attributes: unknown = document.toJS({ maxAliasCount: 100 }) ?? {};
  assertBoundedValue(attributes);
  return {
    attributes: Object.freeze(requireObject(attributes, "YAML frontmatter")),
    body: lines.slice(closingIndex + 1).join("\n"),
    bodyStartLine: closingIndex + 2,
  };
}
