import { defineConfig } from "vitest/config";

// Node 22+ puts an own `localStorage` accessor on globalThis that stays
// undefined without --localstorage-file. happy-dom's environment leaves a
// key the global already has alone, so tests that touch storage would see
// Node's undefined instead of the window's. Older Nodes reject the flag.
const nodeMajor = Number(process.versions.node.split(".")[0]);
const execArgv = nodeMajor >= 22 ? ["--no-experimental-webstorage"] : [];

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    poolOptions: {
      forks: { execArgv },
      threads: { execArgv },
    },
  },
});
