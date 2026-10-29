import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import {
  api,
  CONNECTION_TYPE,
  Connection,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { writeAuditLog } from "../../ops/AuditOps";
import { auditLogs } from "../../schema/audit_logs";
import { tags } from "../../schema/tags";
import {
  call,
  createUserAndLogin,
  HOOK_TIMEOUT,
  retryClearDatabase,
  serverUrl,
  type TestUser,
} from "../setup";

/**
 * `AuditedAction`'s contract, held by throwaway subclasses run in-process on a
 * real booted server and a real database: the audit row and the write are one
 * commit, and the four details that look optional are not. Over HTTP, the same
 * rows carry their organization and actor.
 */
let url: string;
let ada: TestUser;

/** How each throwaway behaves after it writes its tag. */
type Ending = "commit" | "typed" | "untyped" | "refuse" | "hook-throws";

/**
 * A throwaway audited action: writes a tag on `tx`, sets an `auditAfter`
 * snapshot, then ends as told. Never registered: it runs through `run()`
 * directly, the same method Keryx calls.
 */
class Throwaway extends AuditedAction {
  name = "test:throwaway";
  description = "A throwaway audited write for the suite.";
  middleware = [];
  web = { route: "/test/throwaway", method: HTTP_METHOD.PUT };
  inputs = z.object({ projectId: z.number(), name: z.string() });
  /** Whether {@link Throwaway.afterCommit} ran. */
  afterCommitRan = false;

  /** @param ending - How the action ends after its write. */
  constructor(private ending: Ending) {
    super();
  }

  /**
   * @param tx - The shared transaction.
   * @param params - `projectId` and the tag name to write.
   * @param connection - The connection whose metadata carries the snapshot.
   * @returns A literal response, so the return type can be checked.
   */
  async runWithAudit(
    tx: TxHandle,
    params: Record<string, unknown>,
    connection: AuditedConnection,
  ) {
    const [tag] = await tx
      .insert(tags)
      .values({
        projectId: params.projectId as number,
        name: params.name as string,
      })
      .returning();
    connection.metadata.auditAfter = { id: tag.id, name: tag.name };
    if (this.ending === "typed") {
      throw new TypedError({
        message: "changed my mind",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    if (this.ending === "untyped") throw new Error("the disk is on fire");
    if (this.ending === "refuse") {
      connection.metadata.refuseAfterCommit = new TypedError({
        message: "recorded, and refused",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
    return { ok: true as const, tagId: tag.id };
  }

  /** Records that it ran, and throws when told to. */
  async afterCommit() {
    this.afterCommitRan = true;
    if (this.ending === "hook-throws") throw new Error("the queue is down");
  }
}

/**
 * A task connection, the shape a worker gives an action: no session.
 * @returns The connection.
 */
function taskConnection(): AuditedConnection {
  return new Connection(
    CONNECTION_TYPE.TASK,
    `test:audit:${crypto.randomUUID()}`,
  ) as AuditedConnection;
}

/**
 * Every tag and throwaway audit row for a name.
 * @param name - The tag name the throwaway wrote.
 * @returns What survived.
 */
async function survivors(name: string) {
  const tagRows = await api.db.db
    .select()
    .from(tags)
    .where(and(eq(tags.projectId, ada.projectId), eq(tags.name, name)));
  const auditRows = (
    await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "test:throwaway"))
  ).filter((row) => (row.metadata as { name?: string }).name === name);
  return { tagRows, auditRows };
}

beforeAll(async () => {
  await api.start();
  url = serverUrl();
  await retryClearDatabase();
  ada = await createUserAndLogin(url, "Ada Lovelace", "ada@analytical.engine");
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("the audit row and the write are one commit", () => {
  test("a committed write has exactly one audit row, with its snapshot", async () => {
    const action = new Throwaway("commit");
    const result = await action.run(
      { projectId: ada.projectId, name: "kept" },
      taskConnection(),
    );
    // The declared return type survives `run()`: this line is a compile-time
    // check as much as a runtime one.
    const ok: true = result.ok;
    expect(ok).toBe(true);
    const { tagRows, auditRows } = await survivors("kept");
    expect(tagRows).toHaveLength(1);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].after).toEqual({ id: result.tagId, name: "kept" });
    expect(action.afterCommitRan).toBe(true);
  });

  test("a write that then throws leaves neither the row nor its audit entry", async () => {
    const action = new Throwaway("typed");
    const error = await action
      .run({ projectId: ada.projectId, name: "rolled-back" }, taskConnection())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypedError);
    expect((error as TypedError).message).toBe("changed my mind");
    const { tagRows, auditRows } = await survivors("rolled-back");
    expect(tagRows).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
    expect(action.afterCommitRan).toBe(false);
  });
});

describe("the four details", () => {
  test("run() clears a previous action's snapshots before this one runs", async () => {
    // A nested act keeps its parent's metadata; this is that path.
    const connection = taskConnection();
    connection.metadata.auditBefore = { leaked: "before" };
    connection.metadata.auditMetadata = { leaked: "metadata" };
    connection.metadata.auditTargetType = "leaked";
    connection.metadata.auditProjectId = 999_999;
    connection.metadata.auditOrganizationId = 999_999;
    await new Throwaway("commit").run(
      { projectId: ada.projectId, name: "clean-slate" },
      connection,
    );
    const [row] = (await survivors("clean-slate")).auditRows;
    expect(row.before).toBeNull();
    expect(row.targetType).toBeNull();
    expect(row.metadata).toEqual({
      projectId: ada.projectId,
      name: "clean-slate",
    });
    expect(row.projectId).toBe(ada.projectId);
    expect(row.organizationId).toBe(ada.organizationId);
  });

  test("an untyped failure is logged with its cause, then rewrapped", async () => {
    const logged: unknown[][] = [];
    const original = api.logger.error;
    api.logger.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const error = await new Throwaway("untyped")
        .run({ projectId: ada.projectId, name: "on-fire" }, taskConnection())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypedError);
      expect((error as TypedError).type).toBe(ErrorType.CONNECTION_ACTION_RUN);
      expect((error as TypedError).message).not.toContain("disk");
    } finally {
      api.logger.error = original;
    }
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).toContain("test:throwaway");
    expect(logged[0][1]).toMatchObject({ error: "the disk is on fire" });
    expect((await survivors("on-fire")).tagRows).toHaveLength(0);
  });

  test("an afterCommit failure is swallowed: the write already committed", async () => {
    const action = new Throwaway("hook-throws");
    const result = await action.run(
      { projectId: ada.projectId, name: "hook-failed" },
      taskConnection(),
    );
    expect(result.ok).toBe(true);
    expect(action.afterCommitRan).toBe(true);
    const { tagRows, auditRows } = await survivors("hook-failed");
    expect(tagRows).toHaveLength(1);
    expect(auditRows).toHaveLength(1);
  });

  test("a refusal after commit is both recorded and reported", async () => {
    const action = new Throwaway("refuse");
    const error = await action
      .run({ projectId: ada.projectId, name: "refused" }, taskConnection())
      .catch((e: unknown) => e);
    expect((error as TypedError).message).toBe("recorded, and refused");
    expect((await survivors("refused")).auditRows).toHaveLength(1);
    expect(action.afterCommitRan).toBe(false);
  });
});

describe("actors and organizations", () => {
  test("a write with no session and no named actor is the system's", async () => {
    await new Throwaway("commit").run(
      { projectId: ada.projectId, name: "by-the-system" },
      taskConnection(),
    );
    const [row] = (await survivors("by-the-system")).auditRows;
    expect(row.actorType).toBe("system");
    expect(row.userId).toBeNull();
  });

  test("a person's write over HTTP is theirs, filed under the project's organization", async () => {
    const res = await call(url, ada, "PUT", `/project/${ada.projectId}/tag`, {
      name: "engines",
    });
    expect(res.status).toBe(200);
    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "tag:create"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(row).toMatchObject({
      actorType: "user",
      userId: ada.userId,
      participantId: null,
      projectId: ada.projectId,
      organizationId: ada.organizationId,
    });
  });

  test("an organization-level write carries the organization and no project", async () => {
    const res = await call(
      url,
      ada,
      "POST",
      `/organization/${ada.organizationId}`,
      { name: "Analytical Engines" },
    );
    expect(res.status).toBe(200);
    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "organization:edit"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(row.organizationId).toBe(ada.organizationId);
    expect(row.projectId).toBeNull();
    expect(row.actorType).toBe("user");
  });

  test("sign-up's synthetic tenant rows are the system's, naming the owner", async () => {
    const rows = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, ada.organizationId),
          eq(auditLogs.actorType, "system"),
        ),
      )
      .then((all) => all.filter((r) => r.action !== "test:throwaway"));
    expect(rows.map((r) => r.action).sort()).toEqual([
      "organization:create",
      "project:create",
    ]);
    for (const row of rows) {
      expect(row.userId).toBeNull();
      expect(row.metadata).toMatchObject({
        bootstrappedBy: "user:create",
        ownerUserId: ada.userId,
      });
    }
  });

  test("a participant's decision is written with writeAuditLog and files under the project's organization", async () => {
    await api.db.db.transaction(async (tx) => {
      await writeAuditLog(tx, {
        actorType: "participant",
        participantId: 4242,
        projectId: ada.projectId,
        action: "approval:answer",
        targetType: "approval",
        targetPath: "mcp_exec github.create_issue",
        metadata: { answer: "approved" },
      });
    });
    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "approval:answer"));
    expect(row).toMatchObject({
      actorType: "participant",
      participantId: 4242,
      userId: null,
      projectId: ada.projectId,
      organizationId: ada.organizationId,
    });
  });
});
