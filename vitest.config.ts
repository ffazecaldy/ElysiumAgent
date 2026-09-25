import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@elysium/core/": r("packages/core/src/"),
      "@elysium/core": r("packages/core/src/index.ts"),
      "@elysium/meta-layer/": r("packages/meta-layer/src/"),
      "@elysium/meta-layer": r("packages/meta-layer/src/index.ts"),
      "@elysium/extension-tools": r("packages/extension-tools/src/index.ts"),
      "@elysium/tui": r("packages/tui/src/index.ts"),
      "@elysium/benchmarks": r("packages/benchmarks/src/index.ts"),
      "@elysium/cli": r("packages/cli/src/index.ts"),
    },
    // benchmark support sources live outside packages/ but are imported by
    // the offline comparison-layer tests (LIVE Campaign v2)
    extensions: [".ts", ".mts", ".js"],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
});
