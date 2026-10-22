import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { api, config } from "keryx";
import {
  assertClientName,
  assertPublicWebhookUrl,
  buildAppManifest,
  buildAppManifestUrl,
  LINEAR_APP_CREATION_URL,
} from "../../ops/LinearManifestOps";
import schema from "../fixtures/oauth-app-manifest.schema.json";
import { HOOK_TIMEOUT, runAction } from "../setup";

/**
 * Linear's published manifest schema, vendored from
 * `https://linear.app/.well-known/oauth-app-manifest.schema.json`, is the
 * contract: a manifest that passes it is one Linear's creation form accepts.
 */
const validate = (() => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
})();

let savedApplicationUrl: string;
beforeAll(async () => {
  await api.start();
  savedApplicationUrl = config.server.web.applicationUrl;
  // Linear only accepts public HTTPS webhook URLs, as a deployment has.
  config.server.web.applicationUrl = "https://api.hypotenuse.cloud";
}, HOOK_TIMEOUT);
afterAll(async () => {
  config.server.web.applicationUrl = savedApplicationUrl;
  await api.stop();
}, HOOK_TIMEOUT);

describe("the Linear app manifest", () => {
  test("LC-OAUTH-21 the creation link carries a manifest Linear's schema accepts", () => {
    const link = new URL(buildAppManifestUrl());
    expect(`${link.origin}${link.pathname}`).toBe(LINEAR_APP_CREATION_URL);
    const manifest = JSON.parse(link.searchParams.get("manifest")!);
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest).toEqual(buildAppManifest());
    expect(manifest.oauth).toMatchObject({
      client_name: "Hypotenuse",
      redirect_uris: ["https://api.hypotenuse.cloud/api/linear/callback"],
      grant_types: ["authorization_code"],
    });
    expect(manifest.webhook).toEqual({
      enabled: true,
      url: "https://api.hypotenuse.cloud/api/webhooks/linear",
      resourceTypes: [
        "AgentSessionEvent",
        "AppUserNotification",
        "PermissionChange",
        "Issue",
        "Comment",
      ],
    });
    expect(manifest.distribution).toBe("public");
  });

  test("bun keryx.ts linear:manifest-url answers the same link", async () => {
    const { url } = await runAction<{ url: string }>("linear:manifest-url", {
      name: "Hypotenuse Staging",
    });
    const manifest = JSON.parse(new URL(url).searchParams.get("manifest")!);
    expect(manifest.oauth.client_name).toBe("Hypotenuse Staging");
    expect(validate(manifest)).toBe(true);
  });

  test("refuses a client name Linear would refuse, before Linear does", () => {
    for (const name of [
      "Linear Bot",
      "my linear agent",
      "x",
      "https://agent.example",
      "a".repeat(81),
    ]) {
      expect(() => assertClientName(name), name).toThrow();
      // …and the schema agrees, so the guard is not stricter than Linear.
      const manifest = {
        ...buildAppManifest(),
        oauth: { ...buildAppManifest().oauth, client_name: name },
      };
      expect(validate(manifest), name).toBe(false);
    }
    expect(() => assertClientName("Hypotenuse")).not.toThrow();
  });

  test("LC-OAUTH-22 refuses a webhook URL that is not public HTTPS", () => {
    for (const url of [
      "http://api.hypotenuse.cloud/api/webhooks/linear",
      "https://localhost:8080/api/webhooks/linear",
      "https://127.0.0.1/api/webhooks/linear",
      "https://10.0.0.4/api/webhooks/linear",
      "https://192.168.1.2/api/webhooks/linear",
      "https://172.20.0.1/api/webhooks/linear",
      "https://[::1]/api/webhooks/linear",
      "https://linear.app/hooks",
      "https://api.linear.app/hooks",
    ]) {
      expect(() => assertPublicWebhookUrl(url), url).toThrow();
    }
    expect(() =>
      assertPublicWebhookUrl(
        "https://hypotenuse-dev.ngrok.app/api/webhooks/linear",
      ),
    ).not.toThrow();
  });
});
