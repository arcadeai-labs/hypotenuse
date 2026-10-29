/**
 * Apply every pending migration, then exit: `bun scripts/migrate.ts`.
 *
 * This is the API service's Render `preDeployCommand`. Render runs it once per
 * deploy, after the image is built and before the new instance takes traffic,
 * and aborts the deploy (leaving the old instance serving) if it exits
 * non-zero. So the schema a build's `/api/health` probes for is always in place
 * before that build is health-checked, and no deploy waits on another service
 * having migrated first.
 *
 * Keryx has no migrate-only command, so this boots the framework with
 * everything but the database switched off and lets its own `autoMigrate` run
 * the Drizzle migrator — the same code path a development server takes, rather
 * than a second implementation of it. The overrides are set before Keryx is
 * imported because its config is read at import, and they win over `.env` and
 * the service's own `DATABASE_AUTO_MIGRATE=false`.
 */
const OVERRIDES: Record<string, string> = {
  DATABASE_AUTO_MIGRATE: "true",
  WEB_SERVER_ENABLED: "false",
  MCP_SERVER_ENABLED: "false",
  TASKS_ENABLED: "false",
  TASK_PROCESSORS: "0",
};

// `loadFromEnvIfSet` prefers `${KEY}_${NODE_ENV}`, so set both spellings.
const environment = (process.env.NODE_ENV ?? "development").toUpperCase();
for (const [key, value] of Object.entries(OVERRIDES)) {
  process.env[key] = value;
  process.env[`${key}_${environment}`] = value;
}

const { api } = await import("../index");

try {
  await api.start();
  await api.stop();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

// A module, for top-level await; nothing imports this file.
export {};
