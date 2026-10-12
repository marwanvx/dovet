// Module boundary rules: docs/specs/architecture.md "Modules" (one package, enforced boundaries).
// ALLOWED is the "May depend on" column of the module table; every other edge between modules gets its own
// forbidden rule, so a violation names the exact edge (e.g. "no-tools-to-agent").
const ALLOWED = {
  schema: [],
  platform: ["schema"],
  store: ["schema", "platform"],
  policy: ["schema", "platform", "store"],
  tools: ["schema", "platform", "store", "policy"],
  ai: ["schema", "platform", "store"],
  agent: ["schema", "platform", "store", "policy", "tools", "ai", "mcp", "hooks", "lsp"],
  tui: ["schema", "platform", "agent"],
  cli: ["schema", "platform", "store", "policy", "tools", "ai", "agent", "tui", "mcp", "hooks", "lsp"],
  // v0.2 modules, listed now so v0.1 code leaves room for them.
  mcp: ["schema", "platform", "store", "policy", "tools"],
  hooks: ["schema", "platform", "policy"],
  lsp: ["schema", "platform"],
};
const MODULES = Object.keys(ALLOWED);

const edgeRules = MODULES.flatMap((from) =>
  MODULES.filter((to) => to !== from && !ALLOWED[from].includes(to)).map((to) => ({
    name: `no-${from}-to-${to}`,
    comment: `\`${from}\` may not depend on \`${to}\` (architecture "Modules": ${from} may depend on ${ALLOWED[from].join(", ") || "nothing"}).`,
    severity: "error",
    from: { path: `^src/${from}/` },
    to: { path: `^src/${to}/` },
  })),
);

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...edgeRules,
    {
      name: "only-via-index",
      comment: 'Cross-module imports go through the target module\'s `index.ts` (architecture "Conventions").',
      severity: "error",
      from: { path: "^src/([^/]+)/" },
      to: { path: "^src/[^/]+/", pathNot: ["^src/$1/", "^src/[^/]+/index[.]ts$"] },
    },
    {
      name: "no-unknown-module",
      comment:
        'A new folder under src/ is a new module: a spec change to architecture "Repository layout" and an entry here.',
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^src/", pathNot: `^src/(${MODULES.join("|")})/` },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment: "An import that resolves to nothing is a typo or a missing dependency.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
  },
};
