/** @type {ReadonlyArray<{name: string, allowed: readonly string[]}>} */
const packagePolicies = [
  { name: "shared", allowed: ["shared"] },
  { name: "core", allowed: ["core", "shared"] },
  { name: "api", allowed: ["api", "core", "shared"] },
  { name: "asset-library", allowed: ["asset-library", "core", "shared"] },
  { name: "adapters", allowed: ["adapters", "core", "shared"] },
  { name: "scanner", allowed: ["scanner", "adapters", "core", "shared"] },
  { name: "deployer", allowed: ["deployer", "adapters", "core", "shared"] },
  { name: "storage", allowed: ["storage", "core", "shared"] },
  { name: "git", allowed: ["git", "core", "shared"] },
  { name: "local-api", allowed: ["local-api", "api", "shared"] },
];

const packageDependencyRules = packagePolicies.map(({ name, allowed }) => ({
  name: `${name}-package-dependencies`,
  severity: "error",
  from: { path: `^packages/${name}(?:/|$)` },
  to: {
    path: "^packages(?:/|$)",
    pathNot: allowed.map((dependency) => `^packages/${dependency}(?:/|$)`),
  },
}));

const crossPackageSourceRules = packagePolicies.map(({ name }) => ({
  name: `${name}-uses-public-package-entries`,
  severity: "error",
  from: { path: `^packages/${name}(?:/|$)` },
  to: {
    path: "^packages/[^/]+/src/(?!index\\.ts$)",
    pathNot: `^packages/${name}/src(?:/|$)`,
  },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "packages-do-not-depend-on-apps",
      severity: "error",
      from: { path: "^packages(?:/|$)" },
      to: { path: "^apps(?:/|$)" },
    },
    {
      name: "renderer-no-privileged-capabilities",
      severity: "error",
      from: {
        path: "^(?:apps/desktop/src/renderer|apps/web/src/(?!.*\\.test\\.)|tests/architecture/fixtures/renderer)(?:/|$)",
      },
      to: {
        path: "^(?:(?:node:)?(?:fs|fs/promises|child_process|worker_threads|net|tls)|electron|@ai-config-hub/(?:storage|deployer|scanner|adapters|git)|packages/(?:storage|deployer|scanner|adapters|git)(?:/|$))",
      },
    },
    ...packageDependencyRules,
    ...crossPackageSourceRules,
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(?:^|/)dist(?:/|$)",
    tsConfig: { fileName: "tsconfig.base.json" },
  },
};

export default config;
