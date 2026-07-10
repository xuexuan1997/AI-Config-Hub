import type { AdapterReadApi } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ToolInstallationIdSchema,
  type AbsolutePath,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { codexRegistration } from "./codex.js";
import { ADAPTER_DISCOVERY_ENTRY_LIMIT, walkFiles, walkRelativeDirectories } from "./discovery.js";
import { opencodeRegistration } from "./opencode.js";
import type { AdapterDiscoveryLimitError } from "./discovery.js";
import { neverCancelled } from "./test-support.js";

const root = AbsolutePathSchema.parse("/project/config");
const modifiedAt = "2026-06-21T08:00:00.000Z" as const;

describe("bounded adapter discovery", () => {
  it("throws a structured limit error before inspecting entry 10,001", async () => {
    const children = Array.from({ length: ADAPTER_DISCOVERY_ENTRY_LIMIT + 1 }, (_, index) =>
      AbsolutePathSchema.parse(`/project/config/file-${String(index).padStart(5, "0")}.md`),
    );
    let statCalls = 0;
    const read: AdapterReadApi = {
      realpath: (path) => Promise.resolve(path),
      stat: (path) => {
        statCalls += 1;
        return Promise.resolve({
          kind: path === root ? ("directory" as const) : ("file" as const),
          size: 1,
          modifiedAt,
        });
      },
      list: (path) => Promise.resolve(path === root ? children : []),
      readText: () => Promise.reject(new Error("Discovery must not read file contents")),
      snapshotFile: () => Promise.reject(new Error("Discovery must not snapshot file contents")),
    };

    await expect(walkFiles(read, root, neverCancelled)).rejects.toMatchObject({
      name: "AdapterDiscoveryLimitError",
      code: "ADAPTER_DISCOVERY_LIMIT_EXCEEDED",
      root,
      limit: ADAPTER_DISCOVERY_ENTRY_LIMIT,
      observedAtLeast: ADAPTER_DISCOVERY_ENTRY_LIMIT + 1,
    } satisfies Partial<AdapterDiscoveryLimitError>);
    expect(statCalls).toBe(ADAPTER_DISCOVERY_ENTRY_LIMIT + 1);
  });

  it("visits a canonical directory only once when a symlink loops to the root", async () => {
    const loop = AbsolutePathSchema.parse("/project/config/loop");
    let listCalls = 0;
    const read: AdapterReadApi = {
      realpath: (path) => Promise.resolve(path === loop ? root : path),
      stat: (path) =>
        Promise.resolve({
          kind: path === root || path === loop ? ("directory" as const) : ("missing" as const),
          size: 0,
          modifiedAt,
        }),
      list: (path) => {
        listCalls += 1;
        return Promise.resolve(path === root ? [loop] : []);
      },
      readText: () => Promise.reject(new Error("Discovery must not read file contents")),
      snapshotFile: () => Promise.reject(new Error("Discovery must not snapshot file contents")),
    };

    await expect(walkFiles(read, root, neverCancelled)).resolves.toEqual([]);
    expect(listCalls).toBe(1);
  });

  it("shares one entry budget across all documented relative directories", async () => {
    const first = AbsolutePathSchema.parse("/project/config/a");
    const second = AbsolutePathSchema.parse("/project/config/b");
    const filesPerDirectory = ADAPTER_DISCOVERY_ENTRY_LIMIT / 2 + 1;
    const children = new Map<AbsolutePath, readonly AbsolutePath[]>([
      [
        first,
        Array.from({ length: filesPerDirectory }, (_, index) =>
          AbsolutePathSchema.parse(`/project/config/a/file-${String(index)}.md`),
        ),
      ],
      [
        second,
        Array.from({ length: filesPerDirectory }, (_, index) =>
          AbsolutePathSchema.parse(`/project/config/b/file-${String(index)}.md`),
        ),
      ],
    ]);
    const read: AdapterReadApi = {
      realpath: (path) => Promise.resolve(path),
      stat: (path) =>
        Promise.resolve({
          kind:
            path === root || path === first || path === second
              ? ("directory" as const)
              : ("file" as const),
          size: 1,
          modifiedAt,
        }),
      list: (path) => Promise.resolve(children.get(path) ?? []),
      readText: () => Promise.reject(new Error("Discovery must not read file contents")),
      snapshotFile: () => Promise.reject(new Error("Discovery must not snapshot file contents")),
    };

    await expect(
      walkRelativeDirectories(read, root, ["a", "b"], neverCancelled),
    ).rejects.toMatchObject({
      code: "ADAPTER_DISCOVERY_LIMIT_EXCEEDED",
      root,
      limit: ADAPTER_DISCOVERY_ENTRY_LIMIT,
      observedAtLeast: ADAPTER_DISCOVERY_ENTRY_LIMIT + 1,
    });
  });

  it("shares one entry budget across every config root in a tool installation", async () => {
    const agentsRoot = AbsolutePathSchema.parse("/home/.agents");
    const codexRoot = AbsolutePathSchema.parse("/home/.codex");
    const skillsRoot = AbsolutePathSchema.parse("/home/.agents/skills");
    const agentDefinitionsRoot = AbsolutePathSchema.parse("/home/.codex/agents");
    const filesPerRoot = ADAPTER_DISCOVERY_ENTRY_LIMIT / 2 + 1;
    const children = new Map<AbsolutePath, readonly AbsolutePath[]>([
      [
        skillsRoot,
        Array.from({ length: filesPerRoot }, (_, index) =>
          AbsolutePathSchema.parse(`/home/.agents/skills/ignored-${String(index)}.txt`),
        ),
      ],
      [
        agentDefinitionsRoot,
        Array.from({ length: filesPerRoot }, (_, index) =>
          AbsolutePathSchema.parse(`/home/.codex/agents/ignored-${String(index)}.txt`),
        ),
      ],
    ]);
    const files = new Set([...children.values()].flat());
    const directories = new Set([agentsRoot, codexRoot, skillsRoot, agentDefinitionsRoot]);
    const read: AdapterReadApi = {
      realpath: (path) => Promise.resolve(path),
      stat: (path) =>
        Promise.resolve({
          kind: directories.has(path) ? "directory" : files.has(path) ? "file" : "missing",
          size: 1,
          modifiedAt,
        }),
      list: (path) => Promise.resolve(children.get(path) ?? []),
      readText: () => Promise.reject(new Error("Discovery must not read ignored file contents")),
      snapshotFile: () => Promise.reject(new Error("Discovery must not snapshot file contents")),
    };
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    await expect(
      adapter.discover({
        tool: {
          toolId: "codex",
          installationId: ToolInstallationIdSchema.parse("codex:user:/home"),
          configRoots: [agentsRoot, codexRoot],
          evidence: { scope: "user" },
        },
        allowedRoots: [agentsRoot, codexRoot],
        read,
        signal: neverCancelled,
      }),
    ).rejects.toMatchObject({
      code: "ADAPTER_DISCOVERY_LIMIT_EXCEEDED",
      root: agentsRoot,
      limit: ADAPTER_DISCOVERY_ENTRY_LIMIT,
      observedAtLeast: ADAPTER_DISCOVERY_ENTRY_LIMIT + 1,
    });
  });

  it("shares the installation budget across all OpenCode instruction globs", async () => {
    const config = AbsolutePathSchema.parse("/project/config/opencode.json");
    const first = AbsolutePathSchema.parse("/project/config/a");
    const second = AbsolutePathSchema.parse("/project/config/b");
    const filesPerRoot = ADAPTER_DISCOVERY_ENTRY_LIMIT / 2 + 1;
    const children = new Map<AbsolutePath, readonly AbsolutePath[]>([
      [
        first,
        Array.from({ length: filesPerRoot }, (_, index) =>
          AbsolutePathSchema.parse(`/project/config/a/file-${String(index)}.md`),
        ),
      ],
      [
        second,
        Array.from({ length: filesPerRoot }, (_, index) =>
          AbsolutePathSchema.parse(`/project/config/b/file-${String(index)}.md`),
        ),
      ],
    ]);
    const files = new Set([config, ...children.values()].flat());
    const directories = new Set([root, first, second]);
    const read: AdapterReadApi = {
      realpath: (path) => Promise.resolve(path),
      stat: (path) =>
        Promise.resolve({
          kind: directories.has(path) ? "directory" : files.has(path) ? "file" : "missing",
          size: 1,
          modifiedAt,
        }),
      list: (path) => Promise.resolve(children.get(path) ?? []),
      readText: (path) =>
        path === config
          ? Promise.resolve('{"instructions":["a/*.md","b/*.md"]}')
          : Promise.reject(new Error("Discovery must only read the OpenCode config")),
      snapshotFile: () => Promise.reject(new Error("Discovery must not snapshot file contents")),
    };
    const adapter = opencodeRegistration.create({ logger: { debug() {}, warn() {} } });

    await expect(
      adapter.discover({
        tool: {
          toolId: "opencode",
          installationId: ToolInstallationIdSchema.parse("opencode:/project/config"),
          configRoots: [root],
          evidence: {},
        },
        allowedRoots: [root],
        read,
        signal: neverCancelled,
      }),
    ).rejects.toMatchObject({
      code: "ADAPTER_DISCOVERY_LIMIT_EXCEEDED",
      root,
      limit: ADAPTER_DISCOVERY_ENTRY_LIMIT,
      observedAtLeast: ADAPTER_DISCOVERY_ENTRY_LIMIT + 1,
    });
  });
});
