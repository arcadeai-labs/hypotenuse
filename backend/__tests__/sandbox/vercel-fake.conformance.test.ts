import { afterAll, beforeAll, expect } from "bun:test";
import { api, config } from "keryx";
import { VercelSandboxProvider } from "../../sandbox/providers/vercel";
import type { FakeVercel } from "../fakes/vercel/server";
import { buildTestUniverse, type TestUniverse } from "../setup";
import { describeProviderConformance } from "./conformance";
import { buildTestImage, dockerAvailable } from "./harness";
import { connectProjectToFake, startFakeVercel } from "./vercel-fake";

/**
 * The Vercel provider through the conformance suite, against the in-process
 * Vercel fake: the real `@vercel/sandbox` SDK over Vercel's wire protocol,
 * each sandbox a real container. The fake records network policies rather
 * than enforcing them; the nightly run against a real account proves
 * enforcement. Skipped where no Docker daemon answers.
 *
 * The coverage rows (`docs/platform-coverage/vercel.md`) each conformance case
 * proves: `create` — vercel.out.create, vercel.out.cmd; `list` and the orphan
 * sweep — vercel.out.list; `connect` — vercel.out.get; `writeFiles` —
 * vercel.out.fs-write; `readFile` — vercel.out.fs-read; `spawn` —
 * vercel.out.cmd-detached, vercel.out.logs, vercel.out.cmd-get; `kill` —
 * vercel.out.kill; `attach` — vercel.out.cmd-get; `extendTimeout` —
 * vercel.out.extend-timeout; `destroy` — vercel.out.delete.
 */

if (!dockerAvailable) {
  console.warn(
    "\n⚠  Skipping __tests__/sandbox/vercel-fake.conformance.test.ts — no Docker daemon answers here.\n",
  );
}

let fake: FakeVercel;
let u: TestUniverse;
let apiUrl: string;

beforeAll(async () => {
  if (!dockerAvailable) return;
  u = await buildTestUniverse();
  await buildTestImage();
  apiUrl = config.sandbox.vercelApiUrl;
  fake = await startFakeVercel();
  await connectProjectToFake(fake, u.projectId);
}, 300_000);

afterAll(async () => {
  if (!dockerAvailable) return;
  await fake.stop();
  config.sandbox.vercelApiUrl = apiUrl;
  await api.stop();
});

describeProviderConformance({
  name: "vercel (fake)",
  enabled: dockerAvailable,
  timeoutMs: 60_000,
  provider: () =>
    new VercelSandboxProvider({
      token: fake.token,
      teamId: fake.teamId,
      projectId: fake.projectId,
    }),
  createOptions: () => ({ image: "node24", vcpus: 1 }),
  sweepProjectId: () => u.projectId,
  assertEgress: async (sandbox, policy) => {
    const recorded = fake.sandbox(sandbox.id).policies.at(-1);
    expect(recorded).toEqual({ allow: policy.allowDomains ?? [] });
  },
});
