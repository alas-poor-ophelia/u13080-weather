import { defineConfig } from "vitest/config";

// Real-Obsidian e2e walk. Run with `bun run test:e2e` (node + vitest);
// files use the .e2e.ts suffix so `bun test` never picks them up.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ["default"],
  },
});
