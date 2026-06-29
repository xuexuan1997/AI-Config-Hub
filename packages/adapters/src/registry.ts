import type { AdapterLogger, AdapterRegistration, ToolAdapter } from "@ai-config-hub/core";
import type { AdapterId, ToolId } from "@ai-config-hub/shared";

import { claudeCodeRegistration } from "./claude-code.js";
import { codexRegistration } from "./codex.js";
import { cursorRegistration } from "./cursor.js";
import {
  createDeclarativeToolRegistration,
  type DeclarativeToolDefinition,
} from "./declarative-tool.js";
import { opencodeRegistration } from "./opencode.js";

export interface AdapterRegistry {
  readonly toolIds: readonly ToolId[];
  readonly registrations: Readonly<Partial<Record<ToolId, AdapterRegistration>>>;
  create(toolId: ToolId, logger: AdapterLogger): ToolAdapter;
}

export function createAdapterRegistry(
  registrations: readonly AdapterRegistration[],
  customDefinitions: readonly DeclarativeToolDefinition[] = [],
): AdapterRegistry {
  const byTool: Partial<Record<ToolId, AdapterRegistration>> = {};
  const adapterIds = new Set<AdapterId>();
  const allRegistrations = [
    ...registrations,
    ...customDefinitions.map((definition) => createDeclarativeToolRegistration(definition)),
  ];
  for (const registration of allRegistrations) {
    if (registration.contractVersion !== 1) throw new Error("Unsupported adapter contract version");
    if (byTool[registration.toolId] !== undefined) {
      throw new Error(`Duplicate tool registration: ${registration.toolId}`);
    }
    if (adapterIds.has(registration.adapterId)) {
      throw new Error(`Duplicate adapter registration: ${registration.adapterId}`);
    }
    byTool[registration.toolId] = registration;
    adapterIds.add(registration.adapterId);
  }
  const toolIds = Object.freeze(Object.keys(byTool).sort() as ToolId[]);
  const frozenRegistrations = Object.freeze({ ...byTool });

  return Object.freeze({
    toolIds,
    registrations: frozenRegistrations,
    create(toolId: ToolId, logger: AdapterLogger): ToolAdapter {
      const registration = frozenRegistrations[toolId];
      if (registration === undefined) throw new Error(`Adapter is not registered: ${toolId}`);
      const adapter = registration.create({ logger });
      if (
        adapter.toolId !== registration.toolId ||
        adapter.adapterId !== registration.adapterId ||
        adapter.adapterVersion !== registration.adapterVersion
      ) {
        throw new Error(`Adapter factory identity mismatch: ${toolId}`);
      }
      return adapter;
    },
  });
}

const builtInRegistrations = Object.freeze([
  claudeCodeRegistration,
  codexRegistration,
  cursorRegistration,
  opencodeRegistration,
]);

export function createDefaultAdapterRegistry(options?: {
  readonly customTools?: readonly DeclarativeToolDefinition[];
}): AdapterRegistry {
  return createAdapterRegistry(builtInRegistrations, options?.customTools ?? []);
}
