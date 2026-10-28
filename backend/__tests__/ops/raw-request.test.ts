import { describe, expect, test } from "bun:test";
import { readCappedBody } from "../../ops/RawRequestOps";

/**
 * The body reader signed machine ingress uses.
 *
 * Pure: a `Request` in, bytes out. The load-bearing property is that a small
 * body under a large cap does **not** pin the cap in the returned buffer —
 * returning a view into a pre-allocated slab keeps that reservation alive for
 * as long as the caller holds the bytes.
 */

/**
 * A POST `Request` whose body is `bytes`.
 * @param bytes - The body to send.
 * @returns A request the helper can read.
 */
function post(bytes: Uint8Array | string): Request {
  return new Request("http://hypotenuse.test/webhooks/slack", {
    method: "POST",
    body: bytes,
  });
}

describe("readCappedBody", () => {
  test("a small body does not pin the cap in the returned buffer", async () => {
    const cap = 32 * 1024 * 1024;
    const result = await readCappedBody(post("hello"), cap);

    expect(result.oversized).toBe(false);
    expect(result.byteLength).toBe(5);
    expect(new TextDecoder().decode(result.bytes)).toBe("hello");
    // The bug: `new Uint8Array(cap + 1)` plus `subarray` left a 32 MB
    // ArrayBuffer reachable from a 5-byte view for as long as the caller
    // held `bytes`.
    expect(result.bytes.buffer.byteLength).toBeLessThan(1024);
  });

  test("a tiny body does not pin a 256 MB cap", async () => {
    const cap = 256 * 1024 * 1024;
    const result = await readCappedBody(post("0000"), cap);

    expect(result.oversized).toBe(false);
    expect(result.bytes.byteLength).toBe(4);
    expect(result.bytes.buffer.byteLength).toBeLessThan(1024);
  });

  test("a body of exactly the cap is accepted", async () => {
    const cap = 64;
    const body = new Uint8Array(cap).fill(7);
    const result = await readCappedBody(post(body), cap);

    expect(result.oversized).toBe(false);
    expect(result.byteLength).toBe(cap);
    expect(result.bytes.byteLength).toBe(cap);
    expect(result.bytes[0]).toBe(7);
    expect(result.bytes[cap - 1]).toBe(7);
  });

  test("one byte past the cap is oversized and retains only the ceiling", async () => {
    const cap = 64;
    const body = new Uint8Array(cap + 20).fill(9);
    const result = await readCappedBody(post(body), cap);

    expect(result.oversized).toBe(true);
    expect(result.bytes.byteLength).toBe(cap + 1);
    expect(result.bytes.buffer.byteLength).toBe(cap + 1);
  });

  test("an empty body is a zero-length buffer, not the cap", async () => {
    const result = await readCappedBody(post(new Uint8Array(0)), 1024);

    expect(result.oversized).toBe(false);
    expect(result.byteLength).toBe(0);
    expect(result.bytes.byteLength).toBe(0);
    expect(result.bytes.buffer.byteLength).toBe(0);
  });

  test("a chunked stream is concatenated without keeping the cap", async () => {
    const cap = 16 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("aa"));
        controller.enqueue(new TextEncoder().encode("bb"));
        controller.enqueue(new TextEncoder().encode("cc"));
        controller.close();
      },
    });
    const request = new Request("http://hypotenuse.test/webhooks/slack", {
      method: "POST",
      body: stream,
      duplex: "half",
    });

    const result = await readCappedBody(request, cap);
    expect(result.oversized).toBe(false);
    expect(new TextDecoder().decode(result.bytes)).toBe("aabbcc");
    expect(result.bytes.buffer.byteLength).toBe(6);
  });
});
