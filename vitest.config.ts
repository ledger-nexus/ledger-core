import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Tests touch a real Postgres, so don't parallelize across files.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // 60s default — the heavy invariant + property-based suites do
    // dozens of sequential round trips to Neon per test (clear +
    // multi-step posts + reports). Neon's cloud latency is ~50-100ms
    // per query; 20s is too tight when a clearLedger() alone runs 7
    // scoped deleteMany calls.
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
