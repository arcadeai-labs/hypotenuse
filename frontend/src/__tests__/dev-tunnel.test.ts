import { describe, expect, test } from "bun:test";
import { viteDevServerTunnel } from "../../devTunnel";

describe("viteDevServerTunnel", () => {
  test("unset or blank adds nothing to the dev server", () => {
    expect(viteDevServerTunnel(undefined)).toBeUndefined();
    expect(viteDevServerTunnel("  ")).toBeUndefined();
  });

  test("a tunnel host is allowed and HMR goes through it over wss on 443", () => {
    expect(viteDevServerTunnel(" app.example.ngrok.app ")).toEqual({
      allowedHosts: ["app.example.ngrok.app"],
      hmr: { host: "app.example.ngrok.app", protocol: "wss", clientPort: 443 },
    });
  });
});
