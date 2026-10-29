import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import {
  guardedFetch,
  HostRefused,
  isPrivateAddress,
  urlRefusal,
} from "../../ops/NetworkGuardOps";
import { HOOK_TIMEOUT } from "../setup";

beforeAll(async () => {
  await api.initialize();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A resolver that answers fixed addresses.
 * @param addresses - What every name resolves to.
 * @returns The resolver.
 */
const resolvingTo =
  (...addresses: string[]) =>
  async () =>
    addresses;

describe("isPrivateAddress", () => {
  test("every non-public range, in both families", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "ff02::1",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "[::1]",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  test("public addresses and non-addresses are not private", () => {
    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "172.32.0.1",
      "2606:4700::1111",
      "api.openai.com",
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe("urlRefusal", () => {
  const guarded = { allowPrivate: false };

  test("a public https host whose every answer is public passes", async () => {
    expect(
      await urlRefusal("https://api.example.com/v1", {
        ...guarded,
        resolve: resolvingTo("93.184.216.34"),
      }),
    ).toBeNull();
  });

  test("one private answer among public ones refuses the host", async () => {
    expect(
      await urlRefusal("https://api.example.com/v1", {
        ...guarded,
        resolve: resolvingTo("93.184.216.34", "10.0.0.5"),
      }),
    ).toBe(
      "api.example.com resolves to 10.0.0.5, which is not a public address.",
    );
  });

  test("a name that does not resolve is refused", async () => {
    expect(
      await urlRefusal("https://nowhere.example/v1", {
        ...guarded,
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).toBe("nowhere.example does not resolve.");
  });

  test("scheme, credentials, plain http, and private names", async () => {
    const cases: [string, string][] = [
      ["ftp://api.example.com", "The base URL must be an http(s) URL."],
      [
        "https://k:s@api.example.com",
        "The base URL may not carry credentials; the key goes in the API key field.",
      ],
      ["http://api.example.com", "The base URL must use https."],
      ["https://localhost/v1", "localhost is not a public host."],
      ["https://box.local/v1", "box.local is not a public host."],
      ["https://127.0.0.1/v1", "127.0.0.1 is not a public address."],
      ["not a url", "The base URL is not a URL."],
    ];
    for (const [url, refusal] of cases) {
      expect(
        await urlRefusal(url, { ...guarded, resolve: resolvingTo("1.1.1.1") }),
        url,
      ).toBe(refusal);
    }
  });

  test("allowing private hosts lifts everything but the scheme and credentials", async () => {
    expect(
      await urlRefusal("http://127.0.0.1:9/v1", { allowPrivate: true }),
    ).toBeNull();
    expect(
      await urlRefusal("http://k:s@127.0.0.1:9/v1", { allowPrivate: true }),
    ).not.toBeNull();
  });
});

describe("guardedFetch", () => {
  test("connects to exactly the address it checked, so rebinding to a private one is refused", async () => {
    // A server on loopback, reachable by name only through the pinned lookup:
    // the name resolves to loopback, which the guard refuses before connecting.
    const server = Bun.serve({ port: 0, fetch: () => new Response("reached") });
    try {
      await expect(
        guardedFetch(
          `http://rebind.example:${server.port}/`,
          {},
          { allowPrivate: false, resolve: resolvingTo("127.0.0.1") },
        ),
      ).rejects.toBeInstanceOf(HostRefused);

      const allowed = await guardedFetch(
        `http://rebind.example:${server.port}/`,
        {},
        { allowPrivate: true, resolve: resolvingTo("127.0.0.1") },
      );
      expect(await allowed.text()).toBe("reached");
    } finally {
      await server.stop(true);
    }
  });

  test("sends the method, headers, and body, and streams the answer back", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        return Response.json(
          {
            method: req.method,
            auth: req.headers.get("authorization"),
            body: await req.text(),
          },
          { status: 201, headers: { "x-echo": "yes" } },
        );
      },
    });
    try {
      const res = await guardedFetch(
        `http://127.0.0.1:${server.port}/echo`,
        {
          method: "POST",
          headers: { authorization: "Bearer t" },
          body: JSON.stringify({ hello: "world" }),
        },
        { allowPrivate: true },
      );
      expect(res.status).toBe(201);
      expect(res.headers.get("x-echo")).toBe("yes");
      expect(await res.json()).toEqual({
        method: "POST",
        auth: "Bearer t",
        body: '{"hello":"world"}',
      });
    } finally {
      await server.stop(true);
    }
  });

  test("an IP literal is checked without a lookup", async () => {
    await expect(
      guardedFetch("https://10.0.0.5/v1/models", {}, { allowPrivate: false }),
    ).rejects.toThrow("10.0.0.5 is not a public address.");
  });
});
