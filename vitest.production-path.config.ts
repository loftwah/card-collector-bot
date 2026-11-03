import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { TEST_DISCORD_PUBLIC_KEY_HEX } from "./tests/production-path/test-keys.ts";

const migrations = await readD1Migrations("./migrations");

/**
 * Exercises the real Worker entry (`src/worker.ts`) rather than the placeholder
 * test worker. Interactions are intercepted before the EmDash handler, so the
 * routing, signature verification, D1/R2 bindings and `ctx.waitUntil` lifetime
 * are the production code paths.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./dist/server/entry.mjs",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          DISCORD_APPLICATION_ID: "1566702936615026769",
          DISCORD_PUBLIC_KEY: TEST_DISCORD_PUBLIC_KEY_HEX,
        },
      },
    }),
  ],
  test: {
    include: ["tests/production-path/**/*.test.ts"],
    setupFiles: ["./tests/production-path/setup.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
