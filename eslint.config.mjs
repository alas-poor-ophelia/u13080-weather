// ESLint 9 flat config.
//  - eslint-plugin-obsidianmd `recommended` (the preset the Obsidian community-plugin store scan
//    runs) applies to the plugin source only: src/. Build scripts and tests are Node/Bun programs
//    where console output and node: imports are the point. eslint.scanner-replica.mjs is the raw,
//    unmodified replica of the store scan for `bun run lint:scanner`.
//  - typescript-eslint type-checked rules everywhere.
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

const SRC = ["src/**/*.ts"];
// Scope the preset to src/: file-agnostic entries get `files: src/**`; entries that already
// name their files (the preset's TS/JS parser and rule blocks) have every pattern AND-ed with
// src/** (a nested array in `files` means all patterns must match); the package.json checks and
// pure `ignores` entries are left exactly as they are.
const andSrc = (f) => (Array.isArray(f) ? [...f, "src/**/*"] : [f, "src/**/*"]);
const obsidianForSrc = obsidianmd.configs.recommended.map((c) => {
  if (c.ignores && !c.rules && !c.plugins && !c.languageOptions) return c;
  if (!c.files) return { ...c, files: SRC };
  if (c.files.some((f) => String(f).includes("package.json"))) return c;
  return { ...c, files: c.files.map(andSrc) };
});

export default tseslint.config(
  {
    // `.claude/**` is agent scratch — the CLI checks throwaway git worktrees
    // out under it, each with its own built `main.js`, and a bundle that no
    // tsconfig covers stops typed linting dead.
    ignores: ["node_modules/**", ".claude/**", "main.js", "**/*.json", "**/*.mjs", "**/*.cjs", "test/e2e/vault/**", "docs/**", "data/**", "NVIDIA Corporation/**"],
  },
  ...obsidianForSrc,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    },
  },
  {
    // Tests and scripts drive a real Obsidian through page.evaluate and print reports:
    // `any`, non-null assertions and console are the job there.
    files: ["test/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  {
    // withApp() serialises a callback and rebuilds it INSIDE the Obsidian window with `new
    // Function` — that is the bridge, not an eval smell in plugin code.
    files: ["test/e2e/obsidian.ts"],
    rules: { "@typescript-eslint/no-implied-eval": "off" },
  },
);
