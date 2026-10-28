import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Workers integration tests. WebSockets and Durable Objects need a single
 * shared isolate (`--maxWorkers=1 --no-isolate` on `npm run test:workers`).
 * `@cloudflare/vitest-plugin` is the renamed `@cloudflare/vitest-pool-workers`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          SESSION_SECRET: "test-session-secret",
        },
      },
    }),
  ],
  test: {
    name: "workers",
    include: ["test/integration/**/*.test.js"],
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
