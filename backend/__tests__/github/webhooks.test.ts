import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { githubInstallations } from "../../schema/github_installations";
import { triggerEvents } from "../../schema/trigger_events";
import { drainQueue } from "../agent/harness";
import { FakeGitHub } from "../fakes/github/server";
import {
  buildTestUniverse,
  call,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";

/**
 * GitHub App webhooks at the door: `X-Hub-Signature-256` over the raw body
 * (every refusal the same 404, byte for byte), one row per delivery id, an
 * installation nobody attached recorded and answered, `ping`, the body cap,
 * one row per project that attached the installation, and the App's
 * `installation` events suspending and removing what projects attached —
 * driven by the GitHub fake, which signs as GitHub does.
 */
const github = new FakeGitHub();
const saved = { ...config.github };
let u: TestUniverse;
let otherProjectId: number;
let hookUrl: string;

beforeAll(async () => {
  u = await buildTestUniverse();
  await github.start();
  github.configure(config.github as unknown as Record<string, unknown>);
  hookUrl = `${u.url}${config.server.web.apiRoute}/webhooks/github`;
  github.webhookUrl = hookUrl;
  github.install({ id: "9001", login: "acme", repositories: ["api"] });
  const other = await call<{ project: { id: number } }>(
    u.url,
    u.peach,
    "PUT",
    "/project",
    { organizationId: u.organizationId, name: "Annex" },
  );
  if (other.status !== 200) throw new Error(JSON.stringify(other.body));
  otherProjectId = other.body.project.id;
}, HOOK_TIMEOUT);

afterEach(async () => {
  await api.db.db.delete(triggerEvents);
  await api.db.db.delete(githubInstallations);
  config.github.webhookSecret = github.webhookSecret;
  await api.resque.queue.delQueue("ingress");
});

afterAll(async () => {
  Object.assign(config.github, saved);
  await github.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Attach an installation to a project, as the install callback would.
 * @param projectId - The project.
 * @param installationId - GitHub's id.
 * @returns The row's id.
 */
async function attach(
  projectId: number,
  installationId = "9001",
): Promise<number> {
  const [row] = await api.db.db
    .insert(githubInstallations)
    .values({
      projectId,
      installationId,
      accountLogin: "acme",
      accountType: "Organization",
    })
    .returning();
  return row.id;
}

/** A pull request on the fake, for event payloads. */
function pull() {
  return github.openPull({
    owner: "acme",
    name: "api",
    title: "Fix the flaky test",
    body: "",
    head: "hypotenuse/toadsworth/flaky",
    base: "main",
    author: "hypotenuse[bot]",
  });
}

/** Every event row, oldest first. */
async function events() {
  return api.db.db.select().from(triggerEvents).orderBy(triggerEvents.id);
}

/**
 * Post bytes to the webhook URL with chosen headers.
 * @param body - The raw body.
 * @param headers - The headers.
 * @returns The status and body text.
 */
async function post(body: string, headers: Record<string, string>) {
  const res = await fetch(hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe("verification", () => {
  // Coverage: `github.in.signature`.
  test("a good signature is recorded; a bad one, a wrong secret, a missing header, and an unset secret are the same 404", async () => {
    await attach(u.projectId);
    const good = await github.review(pull(), "commented", "Nice.");
    expect(good.status).toBe(200);
    expect(await events()).toHaveLength(1);

    const body = JSON.stringify({ action: "submitted" });
    const sig = (secret: string) =>
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const base = {
      "x-github-event": "pull_request_review",
      "x-github-delivery": crypto.randomUUID(),
    };
    const refusals = [
      await post(body, {
        ...base,
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      }),
      await github.review(pull(), "commented", "Nice.", {
        secret: "not-the-secret",
      }),
      await post(body, base),
      await post(body, {
        ...base,
        "x-hub-signature-256": sig(github.webhookSecret).replace(
          "sha256=",
          "sha1=",
        ),
      }),
    ];
    config.github.webhookSecret = "";
    refusals.push(
      await post(body, { ...base, "x-hub-signature-256": sig("") }),
      await github.review(pull(), "commented", "Nice."),
    );
    const texts = refusals.map((r) => ("text" in r ? r.text : r.body));
    expect(refusals.map((r) => r.status)).toEqual([
      404, 404, 404, 404, 404, 404,
    ]);
    expect(new Set(texts).size).toBe(1);
    expect(await events()).toHaveLength(1);
  });

  // Coverage: `github.in.body-cap`.
  test("a body past the cap is a 413, and nothing is recorded", async () => {
    await attach(u.projectId);
    const big = JSON.stringify({
      pad: "x".repeat(config.platforms.maxBodyBytes + 10),
    });
    const res = await post(big, {
      "x-github-event": "pull_request",
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", github.webhookSecret).update(big).digest("hex")}`,
    });
    expect(res.status).toBe(413);
    expect(await events()).toHaveLength(0);
  });

  // Coverage: `github.in.ping`.
  test("ping answers 200 and records nothing", async () => {
    await attach(u.projectId);
    const res = await github.deliver("ping", {
      zen: "Keep it logically awesome.",
      hook_id: 1,
    });
    expect(res.status).toBe(200);
    expect(await events()).toHaveLength(0);
  });
});

describe("recording", () => {
  // Coverage: `github.in.dedupe`.
  test("the same delivery id twice is one row, processed once", async () => {
    await attach(u.projectId);
    const pr = pull();
    const first = await github.review(pr, "approved", "Ship it.", {
      deliveryId: "dup-1",
    });
    const again = await github.review(pr, "approved", "Ship it.", {
      deliveryId: "dup-1",
    });
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(first.body).toBe(again.body);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "github",
      externalEventId: "dup-1",
      projectId: u.projectId,
      status: "pending",
    });
    expect(rows[0].payload).toMatchObject({
      event: "pull_request_review",
      body: { action: "submitted" },
    });
    const ran = await drainQueue("ingress");
    expect(ran).toEqual(["triggers:process-event"]);
    // Nothing a job opened: recorded, and ignored.
    const [processed] = await events();
    expect(processed).toMatchObject({
      status: "ignored",
      outcome: "no-pull-request",
    });
  });

  // Coverage: `github.in.unknown-installation`.
  test("an installation no project attached is answered 200 and recorded once, ignored", async () => {
    github.install({ id: "9002", login: "globex", repositories: ["web"] });
    const pr = github.openPull({
      owner: "globex",
      name: "web",
      title: "Nope",
      body: "",
      head: "x",
      base: "main",
      author: "someone",
    });
    const res = await github.review(pr, "commented", "Hi.");
    expect(res.status).toBe(200);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: null,
      botInstallationId: 0,
      status: "ignored",
      outcome: "unknown_installation",
    });
    expect(await drainQueue("ingress")).toEqual([]);
  });

  // Coverage: `github.in.projects`.
  test("one delivery for an installation two projects attached is one row each", async () => {
    const castle = await attach(u.projectId);
    const annex = await attach(otherProjectId);
    const res = await github.checkSuite(pull(), "failure");
    expect(res.status).toBe(200);
    const rows = await events();
    expect(rows.map((r) => [r.projectId, r.botInstallationId]).sort()).toEqual(
      [
        [u.projectId, castle],
        [otherProjectId, annex],
      ].sort(),
    );
    expect(new Set(rows.map((r) => r.externalEventId)).size).toBe(1);
    expect(await drainQueue("ingress")).toHaveLength(2);
  });
});

describe("installation events", () => {
  // Coverage: `github.in.installation`.
  test("suspend, unsuspend, and deleted update every project's row for the installation", async () => {
    const castle = await attach(u.projectId);
    const annex = await attach(otherProjectId);
    const rowsOf = () =>
      api.db.db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, "9001"))
        .orderBy(githubInstallations.id);

    expect((await github.installationEvent("9001", "suspend")).status).toBe(
      200,
    );
    await drainQueue("ingress");
    let rows = await rowsOf();
    expect(rows.map((r) => r.id)).toEqual([castle, annex]);
    expect(rows.every((r) => r.suspendedAt !== null)).toBe(true);
    expect(rows.every((r) => r.revokedAt === null)).toBe(true);
    const processed = await events();
    expect(processed.map((e) => [e.status, e.outcome])).toEqual([
      ["processed", "installation:suspend"],
      ["processed", "installation:suspend"],
    ]);

    await github.installationEvent("9001", "unsuspend");
    await drainQueue("ingress");
    rows = await rowsOf();
    expect(rows.every((r) => r.suspendedAt === null)).toBe(true);

    await github.installationEvent("9001", "deleted");
    await drainQueue("ingress");
    rows = await rowsOf();
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });
});
