import { describe, expect, test } from "bun:test";
import {
  AVATAR_ACCEPT,
  avatarProblem,
  botAvatarSrc,
  bytesToBase64,
  MAX_AVATAR_BYTES,
  readAvatar,
} from "../utils/avatar";

describe("avatar checks before upload", () => {
  test("a PNG or JPEG up to 512 KB passes", () => {
    expect(avatarProblem({ type: "image/png", size: 1024 })).toBeNull();
    expect(
      avatarProblem({ type: "image/jpeg", size: MAX_AVATAR_BYTES }),
    ).toBeNull();
  });

  test("another type is refused, naming what to send", () => {
    expect(avatarProblem({ type: "image/gif", size: 10 })).toBe(
      "An avatar must be a PNG or JPEG image.",
    );
    expect(avatarProblem({ type: "", size: 10 })).toContain("PNG or JPEG");
  });

  test("a file over the limit is refused with its size and the limit", () => {
    expect(
      avatarProblem({ type: "image/png", size: MAX_AVATAR_BYTES + 1 }),
    ).toBe("That image is 513 KB; an avatar is at most 512 KB.");
  });

  test("an empty file is refused", () => {
    expect(avatarProblem({ type: "image/png", size: 0 })).toBe(
      "That file is empty.",
    );
  });

  test("the file input offers the same types", () => {
    expect(AVATAR_ACCEPT).toContain("image/png");
    expect(AVATAR_ACCEPT).toContain("image/jpeg");
  });
});

describe("reading an avatar", () => {
  test("bytes encode as base64, across slice boundaries", () => {
    expect(bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(
      "iVBORw==",
    );
    const big = new Uint8Array(0x8000 * 2 + 3).map((_, i) => i % 251);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString("base64"));
  });

  test("a good file reads to base64 with no data: prefix", async () => {
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    expect(await readAvatar(file)).toBe("AQID");
  });

  test("a bad file is refused before it is read", async () => {
    const file = new Blob(["GIF89a"], { type: "image/gif" });
    await expect(readAvatar(file)).rejects.toThrow("PNG or JPEG");
  });
});

describe("where the browser reads an avatar", () => {
  test("the API origin, /api, then the server's versioned path", () => {
    expect(
      botAvatarSrc("http://localhost:8080", "/project/1/bot/2/avatar?v=9"),
    ).toBe("http://localhost:8080/api/project/1/bot/2/avatar?v=9");
  });

  test("a bot without one has no image", () => {
    expect(botAvatarSrc("http://localhost:8080", null)).toBeUndefined();
  });
});
