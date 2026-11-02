import { afterAll, beforeAll } from "bun:test";
import { api } from "keryx";
import { DockerSandboxProvider } from "../../sandbox/providers/docker";
import { retryClearDatabase } from "../setup";
import { describeProviderConformance } from "./conformance";
import {
  buildTestImage,
  destroyManagedContainers,
  dockerAvailable,
  TEST_IMAGE,
} from "./harness";

/**
 * The Docker provider through the conformance suite, in real containers.
 * Skipped where no Docker daemon answers; CI has one.
 */

if (!dockerAvailable) {
  console.warn(
    "\n⚠  Skipping __tests__/sandbox/docker.conformance.test.ts — no Docker daemon answers here.\n",
  );
}

beforeAll(async () => {
  if (!dockerAvailable) return;
  await api.start();
  await retryClearDatabase();
  await buildTestImage();
}, 300_000);

afterAll(async () => {
  if (!dockerAvailable) return;
  await destroyManagedContainers();
  await api.stop();
});

describeProviderConformance({
  name: "docker",
  enabled: dockerAvailable,
  timeoutMs: 60_000,
  provider: () => new DockerSandboxProvider(),
  createOptions: () => ({ image: TEST_IMAGE }),
  sweepProjectId: () => null,
});
