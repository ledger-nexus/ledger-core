import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Tests touch a real Postgres, so don't parallelize across files.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
