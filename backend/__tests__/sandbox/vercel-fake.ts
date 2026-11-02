import { api, config } from "keryx";
import { encryptSecret, lastFourOf } from "../../ops/CryptoOps";
import { projectConnections } from "../../schema/project_connections";
import { FakeVercel } from "../fakes/vercel/server";
import { TEST_IMAGE } from "./harness";

/**
 * Point the Vercel provider at a started fake, and give a project a
 * connection to it written straight to its row (the connection actions'
 * own suite drives them over HTTP).
 * @returns The started fake.
 */
export async function startFakeVercel(): Promise<FakeVercel> {
  const fake = await new FakeVercel(TEST_IMAGE).start();
  config.sandbox.vercelApiUrl = fake.url;
  return fake;
}

/**
 * Write a project's Vercel connection to the fake.
 * @param fake - The fake.
 * @param projectId - The project.
 * @returns The connection row's id.
 */
export async function connectProjectToFake(
  fake: FakeVercel,
  projectId: number,
): Promise<number> {
  const [row] = await api.db.db
    .insert(projectConnections)
    .values({
      projectId,
      kind: "vercel",
      name: "Vercel",
      config: { teamId: fake.teamId, projectId: fake.projectId },
      secret: encryptSecret(fake.token),
      lastFour: lastFourOf(fake.token),
      status: "ok",
    })
    .returning();
  return row.id;
}
