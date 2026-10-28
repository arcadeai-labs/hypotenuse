import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { generateAll, renderKeryxTheme } from "../../../design/tokens";

// `render.yaml` is not code, so nothing else in the suite would notice if it
// drifted from what the app reads — and the feedback loop for a broken blueprint
// is a failed deploy, minutes after merge. These tests parse the real file,
// validate its structure against the subset of Render's blueprint spec we use,
// and assert the invariants that make the topology correct.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Read a repo-root-relative file as UTF-8 text.
 * @param relativePath - Path from the repository root.
 * @returns The file contents.
 */
function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** One `envVars` entry. Strict, so a typo is a parse failure, not a dropped key. */
const envVarSchema = z.union([
  z.strictObject({ fromGroup: z.string() }),
  z.strictObject({ key: z.string(), value: z.string() }),
  z.strictObject({ key: z.string(), generateValue: z.literal(true) }),
  z.strictObject({
    key: z.string(),
    fromDatabase: z.strictObject({
      name: z.string(),
      property: z.literal("connectionString"),
    }),
  }),
  z.strictObject({
    key: z.string(),
    fromService: z.strictObject({
      name: z.string(),
      type: z.string(),
      property: z.literal("connectionString"),
    }),
  }),
]);

/**
 * Instance types Render actually has. An enum rather than a string: Render's
 * validator accepts a plausible marketing name like `starter plus` and then
 * silently creates nothing for the service that names it.
 */
const COMPUTE_PLANS = [
  "free",
  "0.5c-512mb",
  "1c-2g",
  "2c-4g",
  "2c-8g",
  "4c-8g",
  "4c-16g",
  "starter",
  "standard",
  "pro",
] as const;

const dockerService = {
  name: z.string(),
  runtime: z.literal("docker"),
  dockerfilePath: z.string(),
  dockerContext: z.literal("."),
  plan: z.enum(COMPUTE_PLANS),
  region: z.string(),
  branch: z.literal("main"),
  autoDeploy: z.literal(true),
  buildFilter: z.strictObject({ paths: z.array(z.string()).min(1) }),
  envVars: z.array(envVarSchema).min(1),
};

const blueprintSchema = z.strictObject({
  services: z.array(
    z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("web"),
        healthCheckPath: z.string(),
        domains: z.array(z.string()).min(1),
        ...dockerService,
      }),
      z.strictObject({ type: z.literal("worker"), ...dockerService }),
      z.strictObject({
        type: z.literal("keyvalue"),
        name: z.string(),
        plan: z.string(),
        region: z.string(),
        ipAllowList: z.array(z.unknown()),
        maxmemoryPolicy: z.string(),
      }),
    ]),
  ),
  envVarGroups: z.array(
    z.strictObject({ name: z.string(), envVars: z.array(envVarSchema) }),
  ),
  databases: z.array(
    z.strictObject({
      name: z.string(),
      plan: z.string(),
      region: z.string(),
      postgresMajorVersion: z.string(),
      ipAllowList: z.array(z.unknown()),
    }),
  ),
});

type Blueprint = z.infer<typeof blueprintSchema>;
type Service = Blueprint["services"][number];
type EnvVar = z.infer<typeof envVarSchema>;

const blueprint: Blueprint = blueprintSchema.parse(
  Bun.YAML.parse(readRepoFile("render.yaml")),
);

/**
 * Find a service by name, failing the test if it is missing.
 * @param name - The Render service name.
 * @returns The service.
 */
function service(name: string): Service {
  const found = blueprint.services.find((s) => s.name === name);
  if (!found) throw new Error(`render.yaml has no service ${name}`);
  return found;
}

/**
 * The env vars a backend service declares directly (not through its group).
 * @param name - The Render service name.
 * @returns Its `envVars`.
 */
function envOf(name: string): EnvVar[] {
  const s = service(name);
  if (!("envVars" in s)) throw new Error(`${name} has no envVars`);
  return s.envVars;
}

/**
 * A literal `value:` for a key on a service, if it declares one.
 * @param name - The Render service name.
 * @param key - The env var name.
 * @returns The value, or undefined.
 */
function valueOf(name: string, key: string): string | undefined {
  const entry = envOf(name).find((e) => "key" in e && e.key === key);
  return entry && "value" in entry ? entry.value : undefined;
}

const group = blueprint.envVarGroups.find(
  (g) => g.name === "hypotenuse-shared",
);
const BACKENDS = ["hypotenuse-api", "hypotenuse-worker"];

describe("render.yaml", () => {
  test("declares exactly the five resources", () => {
    expect(blueprint.services.map((s) => s.name).sort()).toEqual([
      "hypotenuse-api",
      "hypotenuse-frontend",
      "hypotenuse-redis",
      "hypotenuse-worker",
    ]);
    expect(blueprint.databases.map((d) => d.name)).toEqual(["hypotenuse-db"]);
    expect(blueprint.databases[0]?.postgresMajorVersion).toBe("18");
  });

  test("api and worker share one image and pull the shared group", () => {
    for (const name of BACKENDS) {
      const s = service(name);
      expect("dockerfilePath" in s && s.dockerfilePath).toBe(
        "./backend/Dockerfile",
      );
      expect(envOf(name)).toContainEqual({ fromGroup: "hypotenuse-shared" });
    }
  });

  test("exactly one service migrates, and it is the worker", () => {
    const migrators = BACKENDS.filter(
      (n) => valueOf(n, "DATABASE_AUTO_MIGRATE") === "true",
    );
    expect(migrators).toEqual(["hypotenuse-worker"]);
    expect(valueOf("hypotenuse-api", "DATABASE_AUTO_MIGRATE")).toBe("false");
  });

  test("only the worker runs tasks", () => {
    expect(valueOf("hypotenuse-worker", "TASKS_ENABLED")).toBe("true");
    expect(
      Number(valueOf("hypotenuse-worker", "TASK_PROCESSORS")),
    ).toBeGreaterThan(0);
    expect(valueOf("hypotenuse-api", "TASKS_ENABLED")).toBe("false");
    expect(valueOf("hypotenuse-api", "TASK_PROCESSORS")).toBe("0");
  });

  test("the encryption key is generated once, in the shared group", () => {
    const everywhere = [
      ...blueprint.services.flatMap((s) => ("envVars" in s ? s.envVars : [])),
      ...(group?.envVars ?? []),
    ];
    const keys = everywhere.filter(
      (e) => "key" in e && e.key === "SECRETS_ENCRYPTION_KEY",
    );
    expect(keys).toEqual([
      { key: "SECRETS_ENCRYPTION_KEY", generateValue: true },
    ]);
    expect(group?.envVars).toContainEqual({
      key: "SECRETS_ENCRYPTION_KEY",
      generateValue: true,
    });
  });

  test("no platform secret is an environment variable", () => {
    // One platform app per bot: each bot's Slack, Linear, and Pylon secrets
    // are rows stored encrypted with its installation, never deployment env.
    const declared = [
      ...readRepoFile("render.yaml").matchAll(/^\s*- key: (\S+)/gm),
    ].map((m) => m[1]!);
    const secrets = declared.filter(
      (k) =>
        k.startsWith("LINEAR_") ||
        k.startsWith("SLACK_") ||
        k.startsWith("PYLON_") ||
        k === "SMTP_PASSWORD",
    );
    expect(secrets).toEqual([]);
  });

  test("public origins are https and attached to the service that answers them", () => {
    const api = service("hypotenuse-api");
    const frontend = service("hypotenuse-frontend");
    const domainsOf = (s: Service) => ("domains" in s ? s.domains : []);

    for (const name of BACKENDS) {
      const appUrl = new URL(valueOf(name, "APPLICATION_URL") ?? "");
      expect(appUrl.protocol).toBe("https:");
      expect(domainsOf(api)).toContain(appUrl.host);
    }
    const origin = new URL(
      valueOf("hypotenuse-api", "WEB_SERVER_ALLOWED_ORIGINS") ?? "",
    );
    expect(origin.protocol).toBe("https:");
    expect(domainsOf(frontend)).toContain(origin.host);
    // The apex is attached only to redirect; no origin names it.
    expect(origin.host.startsWith("www.")).toBe(true);
  });

  test("Redis refuses writes rather than evicting", () => {
    const redis = service("hypotenuse-redis");
    expect("maxmemoryPolicy" in redis && redis.maxmemoryPolicy).toBe(
      "noeviction",
    );
  });

  test("every directory a Dockerfile copies is in its service's buildFilter", () => {
    // A directory the image is built from but the filter omits is a change
    // that ships nowhere: the image keeps its stale copy until something else
    // triggers a rebuild.
    for (const s of blueprint.services) {
      if (!("dockerfilePath" in s) || !("buildFilter" in s)) continue;
      const dockerfile = readRepoFile(s.dockerfilePath.replace(/^\.\//, ""));
      const copied = [
        ...dockerfile.matchAll(/^COPY\s+(?!--from)([\w-]+)\/\s/gm),
      ].map(([, dir]) => `${dir}/**`);
      expect(copied.length).toBeGreaterThan(0);
      for (const path of copied) expect(s.buildFilter.paths).toContain(path);
    }
  });

  test("nothing on Render rebuilds for a CLI-only change", () => {
    for (const s of blueprint.services) {
      if (!("buildFilter" in s)) continue;
      expect(s.buildFilter.paths.some((p) => p.startsWith("cli/"))).toBe(false);
    }
  });

  test("the port the Dockerfiles expose is the port the api binds", () => {
    expect(valueOf("hypotenuse-api", "WEB_SERVER_PORT")).toBe("10000");
    for (const file of ["backend/Dockerfile", "frontend/Dockerfile"]) {
      expect(readRepoFile(file)).toContain("EXPOSE 10000");
    }
    expect(readRepoFile("frontend/nginx.conf")).toContain("listen 10000");
  });

  test("the api trusts the proxy so the OAuth issuer is the public origin", () => {
    expect(valueOf("hypotenuse-api", "MCP_OAUTH_TRUST_PROXY")).toBe("true");
  });

  test("the frontend rebuilds when the backend's types change", () => {
    const frontend = service("hypotenuse-frontend");
    expect("buildFilter" in frontend && frontend.buildFilter.paths).toContain(
      "backend/**",
    );
  });

  test("both backends carry the same public origin and dashboard origin", () => {
    // The worker writes links into platforms too; Keryx's default origin is
    // localhost, which no platform user can open.
    const origins = BACKENDS.map((n) => valueOf(n, "APPLICATION_URL"));
    expect(origins[0]).toBeDefined();
    expect(origins[1]).toBe(origins[0]);
    expect(group?.envVars).toContainEqual({
      key: "FRONTEND_URL",
      value: `https://${new URL(valueOf("hypotenuse-api", "WEB_SERVER_ALLOWED_ORIGINS") ?? "").host}`,
    });
  });

  test("the database names the vector extension it requires", () => {
    const text = readRepoFile("render.yaml");
    const databases = text.slice(text.indexOf("\ndatabases:"));
    expect(databases).toContain("`vector` extension");
  });

  test("the api's health check is the probe that fails when unhealthy", () => {
    // Render reads only the HTTP status. /api/status answers 200 whatever it
    // finds, so pointing the check there would promote an unhealthy deploy.
    const api = service("hypotenuse-api");
    expect("healthCheckPath" in api && api.healthCheckPath).toBe("/api/health");
  });

  test("the api answers across origins with a cookie the browser will send", () => {
    expect(valueOf("hypotenuse-api", "SESSION_COOKIE_SECURE")).toBe("true");
    expect(valueOf("hypotenuse-api", "SESSION_COOKIE_SAME_SITE")).toBe("None");
  });

  test("the api points WEB_SERVER_THEME at a file that exists, generated from the tokens", () => {
    // Keryx refuses to boot on a missing theme file, which is how a v1 value
    // left in the dashboard took the api down; and a sync never removes it.
    const themePath = valueOf("hypotenuse-api", "WEB_SERVER_THEME");
    expect(themePath).toBe("theme/hypotenuse-theme.ts");
    expect(readRepoFile(join("backend", themePath!))).toBe(
      renderKeryxTheme(generateAll()),
    );
  });
});
