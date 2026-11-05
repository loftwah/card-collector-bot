import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const testMigrations = process.env.FOILBURY_TEST_MIGRATIONS;
if (!testMigrations?.startsWith("/tmp/foilbury-epoch-test-")) {
  throw new Error("Set FOILBURY_TEST_MIGRATIONS to the temporary test-only migration directory");
}
const migrations = await readD1Migrations(testMigrations);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./tests/workers/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    include: ["tests/workers/**/*.test.ts"],
    setupFiles: ["./tests/workers/setup.ts"],
    testTimeout: 40000,
    hookTimeout: 40000,
  },
});
