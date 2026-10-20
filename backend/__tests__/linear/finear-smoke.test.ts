import { describe, expect, test } from "bun:test";
import { FINEAR_PRIMARY_KEY, useFinear } from "./finear";

const finear = useFinear();

describe("finear", () => {
  test("boots in-process and answers viewer over real HTTP", async () => {
    const res = await fetch(`${finear.url()}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // finear, like Linear, takes a personal API key raw (no `Bearer`).
        Authorization: FINEAR_PRIMARY_KEY,
      },
      body: JSON.stringify({ query: "{ viewer { id name } }" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { viewer: { id: string; name: string } };
      errors?: unknown;
    };
    expect(body.errors).toBeUndefined();
    expect(body.data?.viewer.name).toBe("Human 1");
  });

  test("refuses an unknown key", async () => {
    const res = await fetch(`${finear.url()}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "nope" },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    const body = (await res.json()) as { errors?: unknown[] };
    expect(body.errors?.length ?? 0).toBeGreaterThan(0);
  });
});
