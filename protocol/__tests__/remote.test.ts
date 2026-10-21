import { describe, expect, test } from "bun:test";
import { normalizeRemote } from "../src/remote";

describe("normalizeRemote", () => {
  test("every spelling of one repository is host/owner/name", () => {
    for (const remote of [
      "git@github.com:acme/web.git",
      "https://github.com/acme/web",
      "https://github.com/acme/web.git/",
      "ssh://git@github.com:22/acme/web.git",
      "github.com/acme/web",
      "GitHub.com/acme/web",
    ]) {
      expect(normalizeRemote(remote)).toBe("github.com/acme/web");
    }
  });

  test("the path keeps its case; the host does not", () => {
    expect(normalizeRemote("git@GitLab.example.com:Team/App.git")).toBe(
      "gitlab.example.com/Team/App",
    );
  });
});
