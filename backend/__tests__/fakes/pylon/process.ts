/**
 * The Pylon fake, run as its own process, so a running deployment can be
 * connected to Pylon without one — the docs illustrations
 * (`frontend/scripts/capture-doc-illustrations.ts` starts this by path, as it
 * does the scripted model). It listens on `PYLON_FAKE_PORT` (9190) and
 * accepts one token, `PYLON_FAKE_TOKEN` (`pylon_illustration_0000`), as a
 * token with its own identity named `PYLON_FAKE_NAME` (Ada). Point the
 * backend at it with `PYLON_API_URL_US=http://127.0.0.1:9190/us`.
 */
import { FakePylon } from "./server";

const port = Number(process.env.PYLON_FAKE_PORT ?? 9190);
const pylon = new FakePylon().start(port);
pylon.org = { id: "org_illustration", name: "Acme Support" };
pylon.addToken(
  process.env.PYLON_FAKE_TOKEN ?? "pylon_illustration_0000",
  process.env.PYLON_FAKE_NAME ?? "Ada",
);
console.log(`Pylon fake listening at ${pylon.url}`);
