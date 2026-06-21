import type { AdapterLogger, AdapterRegistration, ToolAdapter } from "@ai-config-hub/core";
import type { AdapterId, ToolId } from "@ai-config-hub/shared";

export interface AdapterRegistry {
  readonly toolIds: readonly ToolId[];
  readonly registrations: Readonly<Partial<Record<ToolId, AdapterRegistration>>>;
  create(toolId: ToolId, logger: AdapterLogger): ToolAdapter;
}

export function createAdapterRegistry(
  registrations: readonly AdapterRegistration[],
): AdapterRegistry {
  const byTool: Partial<Record<ToolId, AdapterRegistration>> = {};
  const adapterIds = new Set<AdapterId>();
  for (const registration of registrations) {
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
