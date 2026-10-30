/**
 * The browser suite's scripted model, run as its own process (the frontend
 * may not import backend code, so `frontend/scripts/e2e-backend.ts` and
 * `frontend/scripts/capture-doc-illustrations.ts` start this by path, as they
 * do the mail catcher). It is the scripted model server the agent suites use,
 * on a port of its own choosing, plus a control server on
 * `MODEL_SERVER_CONTROL_PORT` that a spec or script drives over HTTP:
 *
 * | Route | Does |
 * |---|---|
 * | `GET /connection?provider=anthropic` | `{ baseUrl, apiKey }` to give a model connection |
 * | `POST /play` `{ responses }` | queue scripted responses; answers `{ pending }` |
 * | `GET /state` | `{ pending, completions, expectationFailures }` |
 * | `POST /release` | let every hung response finish |
 * | `POST /reset` | forget the queue and the recorded requests |
 */
import { type ScriptedResponse, startModelServer } from "./model-server";

/** The key the scripted model accepts. Not a secret: it opens nothing real. */
const API_KEY = process.env.MODEL_SERVER_API_KEY ?? "sk-ant-scripted-e2e-0000";

const models = startModelServer({ apiKey: API_KEY });
const control = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.MODEL_SERVER_CONTROL_PORT),
  async fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /connection") {
      const provider = (url.searchParams.get("provider") ??
        "anthropic") as Parameters<typeof models.baseUrl>[0];
      return Response.json({
        baseUrl: models.baseUrl(provider),
        apiKey: API_KEY,
      });
    }
    if (route === "POST /play") {
      const { responses } = (await request.json()) as {
        responses: ScriptedResponse[];
      };
      models.play(responses);
      return Response.json({ pending: models.pending() });
    }
    if (route === "GET /state") {
      return Response.json({
        pending: models.pending(),
        completions: models.completions.length,
        expectationFailures: models.expectationFailures,
      });
    }
    if (route === "POST /release") {
      models.release();
      return Response.json({ released: true });
    }
    if (route === "POST /reset") {
      models.reset();
      return Response.json({ reset: true });
    }
    return Response.json({ error: `No route for ${route}` }, { status: 404 });
  },
});
console.log(`scripted model on ${models.url}, control on ${control.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await models.stop();
    control.stop(true);
    process.exit(0);
  });
}
