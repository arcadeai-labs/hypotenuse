import { describe, expect, test } from "bun:test";
import { isPublicUrl } from "../../ops/AuthSignalOps";

describe("isPublicUrl — what an auth link may point at", () => {
  test("public https names pass", () => {
    for (const url of [
      "https://claude.ai/login",
      "https://github.com/login/device",
      "https://8.8.8.8/x",
      "https://[2606:4700::1111]/x",
    ]) {
      expect(isPublicUrl(url), url).toBe(true);
    }
  });

  test("anything else is refused: http, credentials, local names, private and loopback addresses", () => {
    for (const url of [
      "http://claude.ai/login",
      "https://user:pass@claude.ai/",
      "https://localhost:3000/",
      "https://printer.local/",
      "https://metadata.internal/",
      "https://intranet/",
      "https://127.0.0.1/",
      "https://10.1.2.3/",
      "https://172.20.0.1/",
      "https://192.168.1.1/",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/",
      "https://[::1]/",
      "https://[fd00::1]/",
      "https://[fe80::1]/",
      "https://[::ffff:10.0.0.1]/",
      "not a url",
    ]) {
      expect(isPublicUrl(url), url).toBe(false);
    }
  });
});
