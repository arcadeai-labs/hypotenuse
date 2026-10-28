import { describe, expect, test } from "bun:test";
import {
  SHARED_REDIS_TEST_DATABASE,
  scopedDatabaseUrl,
  scopedRedisUrl,
  unscopedDatabaseUrl,
  unscopedRedisUrl,
} from "../../scripts/workspace";

describe("workspace Redis scoping", () => {
  const shared = `redis://localhost:6379/${SHARED_REDIS_TEST_DATABASE}`;

  test("scoping with a slug moves off the shared index", () => {
    expect(scopedRedisUrl(shared, "feature-x")).not.toBe(shared);
  });

  test("opting out after a pin returns to the shared index", () => {
    // `--shared` after a previous `--id`: the stored URL is already hashed.
    const scoped = scopedRedisUrl(shared, "feature-x");
    expect(scopedRedisUrl(unscopedRedisUrl(scoped, true), "")).toBe(shared);
  });

  test("re-running with the same pin is a no-op", () => {
    const scoped = scopedRedisUrl(shared, "feature-x");
    expect(scopedRedisUrl(unscopedRedisUrl(scoped, true), "feature-x")).toBe(
      scoped,
    );
  });

  test("an unpinned URL is left alone", () => {
    const custom = "redis://cache.internal:6380/7";
    expect(unscopedRedisUrl(custom, false)).toBe(custom);
  });
});

describe("workspace database scoping", () => {
  const base = "postgres://localhost:5432/hypotenuse_test";

  test("a query string does not hide the previous suffix", () => {
    const withQuery = `${base}?sslmode=require`;
    const scoped = scopedDatabaseUrl(withQuery, "foo");
    const rescoped = scopedDatabaseUrl(
      unscopedDatabaseUrl(scoped, "foo"),
      "bar",
    );
    expect(rescoped).toBe(scopedDatabaseUrl(withQuery, "bar"));
    expect(rescoped).not.toContain("foo");
    expect(rescoped).toContain("sslmode=require");
  });

  test("re-running with the same pin is a no-op", () => {
    const scoped = scopedDatabaseUrl(base, "foo");
    expect(scopedDatabaseUrl(unscopedDatabaseUrl(scoped, "foo"), "foo")).toBe(
      scoped,
    );
  });

  test("an unpinned URL is left alone", () => {
    expect(unscopedDatabaseUrl(base, undefined)).toBe(base);
    expect(unscopedDatabaseUrl(base, "")).toBe(base);
  });
});
