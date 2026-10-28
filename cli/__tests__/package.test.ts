import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

describe("the published package", () => {
  test("is named for the command it installs", () => {
    expect(pkg.name).toBe("@arcadeai/hypotenuse");
    expect(Object.keys(pkg.bin)).toEqual(["hypotenuse"]);
  });

  test("names its repository exactly", () => {
    // Self-upgrade derives the GitHub repository whose releases it reads from
    // this URL, so a trailing slash or a missing `.git` breaks it.
    expect(pkg.repository.url).toBe(
      "https://github.com/arcadeai-labs/hypotenuse.git",
    );
  });
});
