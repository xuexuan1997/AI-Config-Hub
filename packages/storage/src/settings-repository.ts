import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { PublicSettings, SettingsRepository } from "@ai-config-hub/core";
import { AbsolutePathSchema, AppError } from "@ai-config-hub/shared";

import { readOnlyError } from "./index-repository.js";
import { parseJson, serializeJson } from "./serialization.js";

const PublicSettingsParser = { parse: parseSettings };

const defaults = parseSettings({
  readOnlyMode: false,
  customScanRoots: [],
  theme: "system",
  language: "system",
  scanHints: true,
  fileWatching: true,
  pathDisplay: "abbreviated",
});

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly readOnly: boolean,
  ) {}

  getPublic(): ReturnType<SettingsRepository["getPublic"]> {
    const row = this.database
      .prepare("SELECT value_json, revision FROM settings WHERE setting_key = 'public_settings'")
      .get() as { value_json: string; revision: number } | undefined;
    return Promise.resolve(
      row === undefined
        ? { revision: "0", settings: defaults }
        : {
            revision: String(row.revision),
            settings: parseJson(PublicSettingsParser, row.value_json),
          },
    );
  }

  updatePublic(
    input: Parameters<SettingsRepository["updatePublic"]>[0],
  ): ReturnType<SettingsRepository["updatePublic"]> {
    if (this.readOnly) return Promise.reject(readOnlyError());
    const settings = parseSettings(input.settings);
    const serialized = serializeJson(settings);
    const expected = Number(input.expectedRevision);
    if (!Number.isSafeInteger(expected) || expected < 0) return Promise.reject(conflict());
    const now = Date.now();
    if (expected === 0) {
      try {
        this.database
          .prepare(
            "INSERT INTO settings(id, setting_key, value_json, visibility, revision, created_at, updated_at) VALUES(?, 'public_settings', ?, 'public', 1, ?, ?)",
          )
          .run(randomUUID(), serialized, now, now);
        return Promise.resolve({ revision: "1", settings });
      } catch {
        return Promise.reject(conflict());
      }
    }
    const result = this.database
      .prepare(
        "UPDATE settings SET value_json = ?, revision = revision + 1, updated_at = ? WHERE setting_key = 'public_settings' AND revision = ?",
      )
      .run(serialized, now, expected);
    if (result.changes !== 1) return Promise.reject(conflict());
    return Promise.resolve({ revision: String(expected + 1), settings });
  }
}

function parseSettings(value: unknown): PublicSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Public settings must be an object");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input["readOnlyMode"] !== "boolean" ||
    typeof input["fileWatching"] !== "boolean" ||
    (input["pathDisplay"] !== "full" && input["pathDisplay"] !== "abbreviated") ||
    !Array.isArray(input["customScanRoots"])
  ) {
    throw new TypeError("Public settings are invalid");
  }
  const theme = input["theme"] ?? "system";
  const language = input["language"] ?? "system";
  const scanHints = input["scanHints"] ?? true;
  if (
    (theme !== "system" && theme !== "light" && theme !== "dark") ||
    (language !== "system" && language !== "en" && language !== "zh-CN") ||
    typeof scanHints !== "boolean"
  ) {
    throw new TypeError("Public settings are invalid");
  }
  return Object.freeze({
    readOnlyMode: input["readOnlyMode"],
    customScanRoots: Object.freeze(
      input["customScanRoots"].map((path) => AbsolutePathSchema.parse(path)),
    ),
    theme,
    language,
    scanHints,
    fileWatching: input["fileWatching"],
    pathDisplay: input["pathDisplay"],
  });
}

function conflict() {
  return new AppError({
    code: "CONFLICT",
    message: "Settings changed since they were read",
    retryable: true,
    suggestedActions: ["Reload settings and retry the update"],
  });
}
