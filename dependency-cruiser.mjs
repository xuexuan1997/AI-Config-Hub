/** @type {ReadonlyArray<{name: string, allowed: readonly string[]}>} */
const packagePolicies = [
  { name: "shared", allowed: ["shared"] },
  { name: "core", allowed: ["core", "shared"] },
  { name: "api", allowed: ["api", "core", "shared"] },
  { name: "adapters", allowed: ["adapters", "core", "shared"] },
  { name: "scanner", allowed: ["scanner", "adapters", "core", "shared"] },
  { name: "deployer", allowed: ["deployer", "adapters", "core", "shared"] },
  { name: "storage", allowed: ["storage", "core", "shared"] },
  { name: "git", allowed: ["git", "core", "shared"] },
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
    path: "^packages/[^/]+/src(?:/|$)",
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
