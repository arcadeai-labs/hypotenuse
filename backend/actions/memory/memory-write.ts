import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { scrubParams } from "../../ops/AuditOps";
import { summarizeText } from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import {
  botChannelInputs,
  documentKey,
  resolveMemoryAccess,
  scopeNameInput,
} from "../../ops/MemoryAccessOps";
import {
  DESCRIPTION_MAX_CHARS,
  memoryPathInput,
} from "../../ops/MemoryChunkOps";
import {
  auditMemoryDocument,
  currentVersion,
  enqueueEmbed,
  lockDocument,
  serializeMemoryDocument,
  writeVersion,
} from "../../ops/MemoryOps";

/**
 * `memory:write` — a person writes a memory document, as a new version: to
 * correct what a bot learned, or to tell every bot something. Channel memory
 * needs the bot's write access; project memory needs admin standing. The
 * audit row keeps the text's length and digest, never the words.
 */
export class MemoryWrite extends AuditedAction {
  name = "memory:write";
  description =
    "Write a memory document as a new version (earlier versions are kept). scope project writes memory every bot of the project shares (admin only); scope channel (with botId and channelId) writes one bot's memory of one channel (needs write access to the bot). Pass baseVersionId to refuse the write if someone changed the document since you read it. Requires membership.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/memory/document",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    scope: scopeNameInput,
    ...botChannelInputs,
    path: memoryPathInput,
    content: z
      .string()
      .min(1, "A memory needs some text")
      .max(100_000, "A memory document holds at most 100,000 characters")
      .describe("The whole document, as markdown"),
    description: z
      .string()
      .max(DESCRIPTION_MAX_CHARS)
      .optional()
      .describe(
        "One line on what the document is about; kept from the last version, or taken from the first line, if omitted",
      ),
    changeNote: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("Why it changed"),
    baseVersionId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "The versionId you edited; the write is refused if it is no longer current",
      ),
  });

  /**
   * @param tx - The transaction the version and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The new version, with its text.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for a stale base.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<MemoryWrite>,
    connection: AuditedConnection,
  ) {
    const access = await resolveMemoryAccess(
      tx,
      params,
      connection.metadata.callerTags ?? [],
      "write",
    );
    const key = documentKey(access, params.scope, params.path);
    connection.metadata.auditTargetType = "memory-document";
    connection.metadata.auditTargetPath = `${params.scope}:${params.path}`;
    connection.metadata.auditMetadata = {
      ...scrubParams({ ...params, content: undefined, description: undefined }),
      content: summarizeText(params.content),
      ...(params.description !== undefined
        ? { description: summarizeText(params.description) }
        : {}),
    };
    await lockDocument(tx, key);
    const current = await currentVersion(tx, key);
    if (
      params.baseVersionId !== undefined &&
      current?.versionId.getTime() !== params.baseVersionId
    ) {
      throw new TypedError({
        message: `This document changed since version ${params.baseVersionId}${current ? `; the current version is ${current.versionId.getTime()}` : ""}. Reload it and make your change again.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "baseVersionId",
      });
    }
    const userId = connection.session?.data.userId ?? null;
    const { row, previous } = await writeVersion(tx, key, {
      content: params.content,
      description: params.description,
      changeNote: params.changeNote ?? null,
      sourceType: "person",
      sourceRef: userId ? { userId } : {},
      authorUserId: userId,
    });
    connection.metadata.auditBefore = previous
      ? auditMemoryDocument(previous)
      : undefined;
    connection.metadata.auditAfter = auditMemoryDocument(row);
    return { document: serializeMemoryDocument(row, { content: true }) };
  }

  /**
   * Embed what was written.
   * @param _result - The response.
   * @param params - The inputs.
   */
  async afterCommit(_result: unknown, params: ActionParams<MemoryWrite>) {
    await enqueueEmbed(params.projectId);
  }
}
