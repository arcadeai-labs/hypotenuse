import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

let url: string;

beforeAll(async () => {
  await api.start();
  url = serverUrl();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

// MCP clients show a connector's icon by asking the server's origin for one —
// usually `/favicon.ico`, sometimes the `<link rel="icon">` on its root page.
describe("favicon on the API origin", () => {
  test("serves /favicon.ico as an ICO holding PNG entries", async () => {
    const res = await fetch(`${url}/favicon.ico`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(0, true)).toBe(0); // reserved
    expect(view.getUint16(2, true)).toBe(1); // type: icon
    const count = view.getUint16(4, true);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const e = 6 + 16 * i;
      sizes.push(bytes[e] || 256);
      const offset = view.getUint32(e + 12, true);
      expect([...bytes.subarray(offset, offset + 4)]).toEqual([
        0x89, 0x50, 0x4e, 0x47,
      ]);
    }
    expect(sizes).toEqual([16, 32, 48, 64]);
  });

  test("serves both SVG marks", async () => {
    for (const path of ["/favicon.svg", "/favicon-dark.svg"]) {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/svg+xml");
      expect(await res.text()).toContain('data-glyph="hypotenuse"');
    }
  });

  test("the root page links every icon", async () => {
    const html = await (await fetch(`${url}/`)).text();
    for (const href of ["/favicon.ico", "/favicon.svg", "/favicon-dark.svg"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});
