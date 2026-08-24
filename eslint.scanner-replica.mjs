// Raw replica of the Obsidian community-plugin store scan: eslint-plugin-obsidianmd's
// `recommended` preset with nothing added and nothing relaxed. `bun run lint:scanner` runs it
// so the store's verdict is known before a release, independent of eslint.config.mjs.
// Mirrors the file of the same name in Windrose.
import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
  },
  { ignores: ["node_modules/**", "main.js", "**/*.json", "**/*.mjs", "**/*.cjs", "test/e2e/vault/**", "data/**", "NVIDIA Corporation/**"] },
];
