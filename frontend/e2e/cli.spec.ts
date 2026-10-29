import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { BACKEND_URL, FRONTEND_URL } from "./env.ts";
import { LANDED, PASSWORD, signUpApi, uniqueEmail } from "./session.ts";

/**
 * Signing in the `hypotenuse` CLI through the real pages. The test plays the
 * CLI: it makes the PKCE pair, listens on a loopback port the way
 * `hypotenuse login` does, and redeems what the browser hands it.
 */

/**
 * base64url without padding.
 * @param bytes - The bytes.
 * @returns The encoded string.
 */
const b64url = (bytes: Buffer) => bytes.toString("base64url");

/** A stand-in for the CLI's loopback listener. */
interface Listener {
  port: number;
  /** Resolves with the callback's query once the browser arrives. */
  callback: Promise<URLSearchParams>;
  close: () => void;
}

/**
 * Listen on `127.0.0.1` like the CLI, redirecting the browser back to the
 * dashboard's outcome page once it arrives.
 * @returns The listener.
 */
async function listen(): Promise<Listener> {
  let resolve!: (params: URLSearchParams) => void;
  const callback = new Promise<URLSearchParams>((r) => {
    resolve = r;
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    resolve(url.searchParams);
    const status = url.searchParams.get("code") ? "done" : "cancelled";
    res.writeHead(302, {
      Location: `${FRONTEND_URL}/cli/authorize?status=${status}`,
    });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    callback,
    close: () => server.close(),
  };
}

/**
 * The link `hypotenuse login` opens, and the verifier it keeps.
 * @param port - The listener's port.
 * @param device - The device name.
 * @returns The path and the PKCE verifier and state.
 */
function authorizeLink(port: number, device: string) {
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(16));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    port: String(port),
    state,
    code_challenge: challenge,
    device,
  });
  return { path: `/cli/authorize?${params}`, verifier, state };
}

/**
 * Call `/api/me` with a bearer token.
 * @param token - The CLI token.
 * @returns The HTTP status and body.
 */
async function meWith(token: string) {
  const res = await fetch(`${BACKEND_URL}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    status: res.status,
    body: (await res.json()) as { user?: { email: string } },
  };
}

test.describe("signing in the CLI", () => {
  test("a signed-out person signs up, approves, and the CLI holds a token that is them", async ({
    page,
  }) => {
    const listener = await listen();
    try {
      const { path, verifier, state } = authorizeLink(
        listener.port,
        "e2e-laptop",
      );

      // Signed out: the approval link survives sign-in, and sign-up.
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in\?next=/, LANDED);
      await page.getByTestId("sign-up-link").click();
      await expect(page).toHaveURL(/\/sign-up\?next=/);
      const email = uniqueEmail("cli");
      await page.getByTestId("sign-up-name").fill("Clio Terminal");
      await page.getByTestId("sign-up-email").fill(email);
      await page.getByTestId("sign-up-password").fill(PASSWORD);
      await page.getByTestId("sign-up-submit").click();

      await expect(page.getByTestId("cli-authorize")).toBeVisible(LANDED);
      await expect(page.getByTestId("cli-authorize")).toContainText(
        "e2e-laptop",
      );
      await expect(page.getByTestId("cli-authorize")).toContainText(email);
      await page.getByTestId("cli-authorize-approve").click();

      const params = await listener.callback;
      expect(params.get("state")).toBe(state);
      await expect(page.getByTestId("cli-authorize-done")).toBeVisible(LANDED);

      const exchange = await fetch(`${BACKEND_URL}/api/cli-auth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: params.get("code"),
          codeVerifier: verifier,
        }),
      });
      const { token } = (await exchange.json()) as { token: string };
      expect(token).toMatch(/^hyp_cli_/);
      const me = await meWith(token);
      expect(me.body.user?.email).toBe(email);

      // Account → CLI sign-ins lists it, and Revoke signs the CLI out.
      await page.goto("/account");
      const table = page.getByTestId("cli-sign-ins-table");
      await expect(table).toContainText("e2e-laptop", LANDED);
      await table.getByRole("button", { name: "Revoke" }).click();
      await expect(page.getByTestId("cli-sign-ins-empty")).toBeVisible(LANDED);
      expect((await meWith(token)).status).toBe(401);
    } finally {
      listener.close();
    }
  });

  test("Cancel tells the CLI no, and nothing is issued", async ({ page }) => {
    const listener = await listen();
    try {
      await signUpApi(page.request, "Cass Cancel", uniqueEmail("cancel"));

      const { path } = authorizeLink(listener.port, "e2e-cancel");
      await page.goto(path);
      await page.getByTestId("cli-authorize-cancel").click();
      const params = await listener.callback;
      expect(params.get("error")).toBe("access_denied");
      expect(params.get("code")).toBeNull();
      await expect(page.getByTestId("cli-authorize-cancelled")).toBeVisible(
        LANDED,
      );
    } finally {
      listener.close();
    }
  });

  test("a malformed link is refused on the page", async ({ page }) => {
    await signUpApi(page.request, "Mal Formed", uniqueEmail("malformed"));
    await page.goto("/cli/authorize?port=1&state=x");
    await expect(page.getByTestId("cli-authorize-invalid")).toBeVisible(LANDED);
    await expect(page.getByTestId("cli-authorize-approve")).toHaveCount(0);
  });

  test("--device: a code typed on the activate page signs the CLI in", async ({
    page,
  }) => {
    const email = uniqueEmail("device");
    await signUpApi(page.request, "Dev Ice", email);

    const started = await fetch(`${BACKEND_URL}/api/cli-auth/device`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: "e2e-ssh-box" }),
    });
    const { deviceCode, userCode } = (await started.json()) as {
      deviceCode: string;
      userCode: string;
    };

    await page.goto("/cli/activate");
    await page.getByTestId("cli-activate-code").fill(userCode.toLowerCase());
    await page.getByTestId("cli-activate-submit").click();
    await expect(page.getByTestId("cli-activate-done")).toContainText(
      "e2e-ssh-box",
      LANDED,
    );

    const polled = await fetch(`${BACKEND_URL}/api/cli-auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
    const { status, token } = (await polled.json()) as {
      status: string;
      token: string;
    };
    expect(status).toBe("approved");
    expect((await meWith(token)).body.user?.email).toBe(email);
  });
});
