import { afterAll, beforeAll, expect } from "bun:test";
import { api } from "keryx";
import { encryptSecret, lastFourOf } from "../../ops/CryptoOps";
import { VercelSandboxProvider } from "../../sandbox/providers/vercel";
import type { Sandbox } from "../../sandbox/types";
import { projectConnections } from "../../schema/project_connections";
import { buildTestUniverse, type TestUniverse } from "../setup";
import { describeProviderConformance } from "./conformance";

/**
 * The Vercel provider through the conformance suite **against a real Vercel
 * account**, outside the CI gate: `.github/workflows/nightly-vercel-sandbox.yml`
 * runs it with `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`, and
 * it is skipped anywhere they are not set. Here the network policy is
 * enforced by the platform, so `setEgress` is proved by trying the network
 * (coverage row vercel.egress.enforced).
 */

const token = process.env.VERCEL_TOKEN ?? "";
const teamId = process.env.VERCEL_TEAM_ID ?? "";
const projectId = process.env.VERCEL_PROJECT_ID ?? "";
const enabled = Boolean(token && teamId && projectId);

if (!enabled) {
  console.warn(
    "\n⚠  Skipping __tests__/sandbox/vercel.conformance.test.ts — VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID are not all set.\n",
  );
}

let u: TestUniverse;

beforeAll(async () => {
  if (!enabled) return;
  u = await buildTestUniverse();
  await api.db.db.insert(projectConnections).values({
    projectId: u.projectId,
    kind: "vercel",
    name: "Vercel",
    config: { teamId, projectId },
    secret: encryptSecret(token),
    lastFour: lastFourOf(token),
    status: "ok",
  });
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  await api.stop();
});

/**
 * Whether a URL answers from inside a sandbox.
 * @param sandbox - The sandbox.
 * @param url - What to fetch.
 * @returns `true` when curl got any HTTP answer.
 */
async function reaches(sandbox: Sandbox, url: string): Promise<boolean> {
  const r = await sandbox.exec("curl", [
    "-sS",
    "-m",
    "10",
    "-o",
    "/dev/null",
    url,
  ]);
  return r.exitCode === 0;
}

describeProviderConformance({
  name: "vercel (real account)",
  enabled,
  timeoutMs: 180_000,
  provider: () => new VercelSandboxProvider({ token, teamId, projectId }),
  createOptions: () => ({ image: "node24", vcpus: 1 }),
  sweepProjectId: () => u.projectId,
  assertEgress: async (sandbox, policy) => {
    expect(policy.allowDomains).toContain("example.org");
    expect(await reaches(sandbox, "https://example.org")).toBe(true);
    expect(await reaches(sandbox, "https://example.com")).toBe(false);
  },
});
