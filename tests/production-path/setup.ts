import { env, applyD1Migrations } from "cloudflare:test";

const migrations = (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
  .TEST_MIGRATIONS;
if (migrations?.length) {
  await applyD1Migrations(env.DB, migrations);
}
