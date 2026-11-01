import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * **Pin Slack's published schemas for the Slack fake.**
 *
 * The fake (`__tests__/fakes/slack/server.ts`) validates every Web API call
 * Hypotenuse makes, and every manifest it generates, against what Slack
 * publishes — so a request real Slack would reject fails a test, not
 * production. This script fetches:
 *
 * - the Web API's OpenAPI 2 spec (`slackapi/slack-api-specs`,
 *   `web-api/slack_web_openapi_v2.json`), reduced to the methods we call;
 * - the app manifest's JSON Schema (`slackapi/manifest-schema`, tag
 *   `v0.6.0`, `schemas/manifest.schema.1.0.0.json`);
 *
 * checks each against the SHA-256 pinned below (a changed upstream file
 * fails loudly rather than silently changing what the fake accepts), and
 * writes them to `__tests__/fakes/slack/spec/`, which is committed so the
 * suite never needs the network. Methods newer than the spec (streaming, the
 * assistant status, app manifests) are described in `supplement.ts` beside
 * them, each citing its documentation page.
 *
 * Run: `bun run slack:fetch-spec` (from `backend/`).
 */

/** The sources, and the hash each must have. */
const SOURCES = {
  webApi: {
    url: "https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json",
    sha256: "742a5c977180a829df8767cf57bc417d99b3713583aee83741efb9c08ca731e7",
  },
  manifest: {
    url: "https://raw.githubusercontent.com/slackapi/manifest-schema/v0.6.0/schemas/manifest.schema.1.0.0.json",
    sha256: "801bb1df2246e72ea012d5feb47fc2877e610b1ecdb58e4a53b79f2c33755e49",
  },
} as const;

/** The Web API methods Hypotenuse calls that the published spec describes. */
export const SPEC_METHODS = [
  "auth.test",
  "oauth.v2.access",
  "chat.postMessage",
  "chat.update",
  "chat.postEphemeral",
  "users.info",
  "conversations.replies",
] as const;

/** Where the pinned files go. */
const OUT = path.join(
  import.meta.dir,
  "..",
  "__tests__",
  "fakes",
  "slack",
  "spec",
);

/**
 * Fetch a source and check its hash.
 * @param source - The URL and the hash it must have.
 * @returns The body.
 */
async function fetchPinned(source: { url: string; sha256: string }) {
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`${source.url} answered HTTP ${res.status}`);
  const text = await res.text();
  const hash = createHash("sha256").update(text).digest("hex");
  if (hash !== source.sha256) {
    throw new Error(
      `${source.url} changed upstream (sha256 ${hash}, pinned ${source.sha256}). Review the change, then update the pin.`,
    );
  }
  return text;
}

/** One parameter of a method, as the fake checks it. */
interface Param {
  type: string;
  required: boolean;
}

/**
 * Reduce the OpenAPI spec to the parameters of the methods we call.
 * @param spec - The parsed spec.
 * @returns Each method's parameters, keyed by name.
 */
function reduce(spec: {
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: {
          name: string;
          in: string;
          type?: string;
          required?: boolean;
        }[];
      }
    >
  >;
}) {
  const methods: Record<
    string,
    { token: boolean; params: Record<string, Param> }
  > = {};
  for (const name of SPEC_METHODS) {
    const op = spec.paths[`/${name}`]?.post ?? spec.paths[`/${name}`]?.get;
    if (!op) throw new Error(`The spec has no ${name}`);
    const params: Record<string, Param> = {};
    let token = false;
    for (const p of op.parameters ?? []) {
      if (p.name === "token" && p.in === "header") {
        token = Boolean(p.required);
        continue;
      }
      params[p.name] = {
        type: p.type ?? "string",
        required: Boolean(p.required),
      };
    }
    methods[name] = { token, params };
  }
  return methods;
}

if (import.meta.main) {
  await mkdir(OUT, { recursive: true });
  const webApi = JSON.parse(await fetchPinned(SOURCES.webApi));
  await Bun.write(
    path.join(OUT, "web-api.json"),
    `${JSON.stringify(
      {
        source: SOURCES.webApi.url,
        sha256: SOURCES.webApi.sha256,
        methods: reduce(webApi),
      },
      null,
      2,
    )}\n`,
  );
  const manifest = await fetchPinned(SOURCES.manifest);
  await Bun.write(path.join(OUT, "manifest.schema.json"), manifest);
  console.log(
    `Pinned ${SPEC_METHODS.length} Web API methods and the manifest schema in ${OUT}`,
  );
}
