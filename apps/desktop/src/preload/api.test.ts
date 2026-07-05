import { API_COMMAND_NAMES } from "@ai-config-hub/api";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

import { createDesktopApi, type PreloadTransport } from "./api.js";

describe("Desktop preload API", () => {
  it("exposes only the named frozen API surface", () => {
    const transport = fakeTransport();
    const api = createDesktopApi(transport, { requestId: () => "request-1" });

    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual([
      "appVersion",
      "invoke",
      "selectProjectRoot",
      "subscribeTask",
    ]);
  });

  it("builds validated command-channel requests and removes task listeners", async () => {
    const invoke = vi.fn().mockResolvedValue({
      apiVersion: 1,
      requestId: "request-1",
      ok: true,
      data: {},
    });
    const off = vi.fn();
    const transport: PreloadTransport = { invoke, on: vi.fn(), off };
    const api = createDesktopApi(transport, { requestId: () => "request-1" });

    await api.invoke("scan.start", { mode: "full" });
    const unsubscribe = api.subscribeTask("task-1", 0, vi.fn());
    unsubscribe();

    expect(invoke).toHaveBeenCalledWith("ai-config-hub:v1:scan.start", {
      apiVersion: 1,
      requestId: "request-1",
      payload: { mode: "full" },
    });
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported command names before invoking IPC", async () => {
    const invoke = vi.fn();
    const transport: PreloadTransport = { invoke, on: vi.fn(), off: vi.fn() };
    const api = createDesktopApi(transport, { requestId: () => "request-1" });

    await expect(api.invoke("node:fs" as never, {} as never)).rejects.toThrow(
      "Unsupported API command",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the production preload command whitelist aligned with API commands", () => {
    const preloadPath = resolve(dirname(fileURLToPath(import.meta.url)), "preload.cts");
    const sourceFile = ts.createSourceFile(
      preloadPath,
      readFileSync(preloadPath, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
    );

    expect(readonlyStringArrayConst(sourceFile, "API_COMMAND_NAMES")).toEqual([
      ...API_COMMAND_NAMES,
    ]);
  });
});

function fakeTransport(): PreloadTransport {
  return {
    invoke: vi
      .fn()
      .mockResolvedValue({ apiVersion: 1, requestId: "request-1", ok: true, data: {} }),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function readonlyStringArrayConst(sourceFile: ts.SourceFile, name: string): readonly string[] {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const initializer = declaration.initializer;
      if (initializer === undefined) return [];
      const arrayLiteral = ts.isAsExpression(initializer) ? initializer.expression : initializer;
      if (!ts.isArrayLiteralExpression(arrayLiteral)) return [];
      return arrayLiteral.elements
        .filter((element): element is ts.StringLiteral => ts.isStringLiteral(element))
        .map((element) => element.text);
    }
  }
  return [];
}
