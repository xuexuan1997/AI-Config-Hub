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
      name: "shared-is-foundational",
      severity: "error",
      from: { path: "^packages/shared(?:/|$)" },
      to: { path: "^(?:packages|apps)/(?!shared(?:/|$))" },
    },
    {
      name: "core-depends-only-on-shared",
      severity: "error",
      from: { path: "^packages/core(?:/|$)" },
      to: { path: "^packages/(?!shared(?:/|$))" },
    },
    {
      name: "api-depends-only-on-core-and-shared",
      severity: "error",
      from: { path: "^packages/api(?:/|$)" },
      to: { path: "^packages/(?!(?:core|shared)(?:/|$))" },
    },
    {
      name: "packages-do-not-depend-on-apps",
      severity: "error",
      from: { path: "^packages(?:/|$)" },
      to: { path: "^apps(?:/|$)" },
    },
    {
      name: "no-cross-package-source-imports",
      severity: "error",
      from: { path: "^(?:packages|apps)/([^/]+)/src" },
      to: { path: "^(?:packages|apps)/(?!$1(?:/|$))[^/]+/src" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(?:^|/)dist(?:/|$)",
    tsConfig: { fileName: "tsconfig.base.json" },
  },
};

export default config;
