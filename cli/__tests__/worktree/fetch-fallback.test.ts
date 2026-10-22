import { expect, test } from "bun:test";
import { join } from "node:path";
import { WorkspaceError } from "../../src/worktree/manager";
import { fixture, git, request, routeOrigin } from "./repo";

test("an unreachable origin with a local origin/<base> works from it, and says so", async () => {
  const f = fixture();
  routeOrigin(f.clone, join(f.root, "nowhere.git"));
  const ws = await f.manager.acquire(request(f));
  expect(git(ws.cwd, "rev-parse", "HEAD")).toBe(
    git(f.origin, "rev-parse", "main"),
  );
  const thought = f.events.find((e) => e.type === "thought");
  expect(thought).toMatchObject({
    type: "thought",
    ephemeral: false,
  });
  expect((thought as { body: string }).body).toMatch(
    /^Could not fetch web; working from the last fetched origin\/main/,
  );
});

test("an unreachable origin with no local origin/<base> fails the turn with git's words", async () => {
  const f = fixture({ fetched: false });
  routeOrigin(f.clone, join(f.root, "nowhere.git"));
  const failure = await f.manager.acquire(request(f)).catch((e) => e);
  expect(failure).toBeInstanceOf(WorkspaceError);
  expect((failure as WorkspaceError).body).toMatch(
    /^Could not fetch `main` from github.com\/acme\/web, and ~\/web has no earlier copy of origin\/main/,
  );
  expect((failure as WorkspaceError).body).toContain("```");
  expect(f.state.worktrees()).toEqual([]);
});
