import { eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  assertMemoryAdmin,
  documentKey,
  resolveMemoryAccess,
} from "../../ops/MemoryAccessOps";
import { memoryPathInput } from "../../ops/MemoryChunkOps";
import {
  auditMemoryDocument,
  enqueueEmbed,
  keyIn,
  memoryNotFound,
  readVersion,
  serializeMemoryDocument,
  writeVersion,
} from "../../ops/MemoryOps";
import { customerNamedIn } from "../../ops/PromotionGuardOps";
import { channels } from "../../schema/channels";

/**
 * `memory:promote` — copy a channel's memory into project memory, where
 * every bot in every channel reads it. **The** way channel content reaches
 * project scope: a person's decision, audited, made by someone who may both
 * change the channel's memory and administer the project. The new project version cites
 * the channel version it came from; the channel document stays.
 */
export class MemoryPromote extends AuditedAction {
  name = "memory:promote";
  description =
    "Promote a channel memory document to project memory, so every bot in every channel of the project sees it. The project copy cites the channel version it came from, and the channel copy stays. Requires write access to a bot working in the channel and admin standing in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/memory/document/promote",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    channelId: idInput("The channel"),
    path: memoryPathInput,
    versionId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("Promote this version; omit for the current one"),
    targetPath: memoryPathInput
      .optional()
      .describe("Where it goes in project memory; the same path if omitted"),
    changeNote: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("Why it is promoted"),
  });

  /**
   * @param tx - The transaction the project version and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The project version.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`; `CONNECTION_CHANNEL_AUTHORIZATION`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<MemoryPromote>,
    connection: AuditedConnection,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    const access = await resolveMemoryAccess(
      tx,
      { ...params, scope: "channel" },
      callerTags,
      "write",
    );
    assertMemoryAdmin(callerTags);
    const source = await readVersion(
      tx,
      documentKey(access, "channel", params.path),
      params.versionId,
    );
    if (!source || source.tombstone) throw memoryNotFound();
    // A customer's facts stay with that customer: a fact from a support
    // account's memory that names the customer is not promoted.
    const [channel] = await tx
      .select()
      .from(channels)
      .where(eq(channels.id, params.channelId))
      .limit(1);
    const named = channel ? customerNamedIn(channel, source.content) : null;
    if (named) {
      throw new TypedError({
        message: `This fact names the customer (“${named}”), and a customer's facts stay in that customer's memory. Write a version that names no customer — no company name and no domain — and promote that instead.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "path",
      });
    }
    const target = keyIn(
      access.readSet,
      "project",
      params.targetPath ?? params.path,
    );
    const userId = connection.session?.data.userId ?? null;
    const { row, previous } = await writeVersion(tx, target, {
      content: source.content,
      description: source.description,
      changeNote:
        params.changeNote ??
        `Promoted from ${access.channel?.name ?? "a channel"}'s memory`,
      sourceType: "promotion",
      sourceRef: {
        promotedFromId: source.id,
        promotedFromChannelId: params.channelId,
        ...(userId ? { userId } : {}),
      },
      authorUserId: userId,
    });
    connection.metadata.auditTargetType = "memory-document";
    connection.metadata.auditTargetPath = `project:${target.path}`;
    connection.metadata.auditBefore = previous
      ? auditMemoryDocument(previous)
      : undefined;
    connection.metadata.auditAfter = auditMemoryDocument(row);
    return {
      document: serializeMemoryDocument(row, { content: true }),
      promotedFrom: serializeMemoryDocument(source),
    };
  }

  /**
   * Embed the project copy.
   * @param _result - The response.
   * @param params - The inputs.
   */
  async afterCommit(_result: unknown, params: ActionParams<MemoryPromote>) {
    await enqueueEmbed(params.projectId);
  }
}
