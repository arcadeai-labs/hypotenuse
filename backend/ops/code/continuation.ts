import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { projects } from "../../schema/projects";
import {
  decryptBytes,
  type EncryptedSecret,
  encryptBytes,
  encryptSecret,
} from "../CryptoOps";
import type { DbHandle } from "../DbOps";

/**
 * **Continuations**: what makes a resumed program the same program.
 *
 * Run signs each continuation with an HMAC key and binds it to an audience,
 * the source, the host-function names, and an authenticated context; a
 * mismatch is refused before any settled result is replayed or an
 * interrupted call is reinvoked. Signing gives integrity, not secrecy — the
 * token carries the source and every settled call's result — so it is sealed
 * with `CryptoOps` (AES-256-GCM) before it is stored, and is never shown to a
 * model, written to a transcript, or logged.
 *
 * | Bound by | Value |
 * |---|---|
 * | the key | the project's own 32 random bytes, `projects.codeContinuationKey` |
 * | the audience | `hypotenuse-run-v1:<projectId>:<conversationId>:<intentEntryId>:<codeRunId>` |
 * | the context | the same four ids and the bot's |
 */

/** The ids a continuation is bound to. */
export interface ContinuationScope {
  projectId: number;
  botId: number;
  conversationId: number;
  intentEntryId: number;
  codeRunId: number;
}

/**
 * The audience of a run's continuation.
 * @param s - The run's scope.
 * @returns `hypotenuse-run-v1:<project>:<conversation>:<intent>:<run>`.
 */
export function audienceOf(s: ContinuationScope): string {
  return `hypotenuse-run-v1:${s.projectId}:${s.conversationId}:${s.intentEntryId}:${s.codeRunId}`;
}

/**
 * The authenticated context a run's continuation carries.
 * @param s - The run's scope.
 * @returns The context, unchanged on every resume.
 */
export function contextOf(s: ContinuationScope): Record<string, unknown> {
  return {
    projectId: s.projectId,
    botId: s.botId,
    conversationId: s.conversationId,
    intentEntryId: s.intentEntryId,
    codeRunId: s.codeRunId,
  };
}

/**
 * The project's continuation key, created on first use. The write only fills
 * an empty column, so when two workers race, one key wins and both read it.
 * @param db - A database handle.
 * @param projectId - The project.
 * @returns The 32 key bytes.
 */
export async function projectContinuationKey(
  db: DbHandle,
  projectId: number,
): Promise<Uint8Array> {
  const read = async () => {
    const [row] = await db
      .select({ key: projects.codeContinuationKey })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row?.key ?? null;
  };
  let sealed = await read();
  if (!sealed) {
    await db
      .update(projects)
      .set({ codeContinuationKey: encryptBytes(randomBytes(32)) })
      .where(
        and(eq(projects.id, projectId), isNull(projects.codeContinuationKey)),
      );
    sealed = await read();
  }
  if (!sealed) throw new Error(`Project ${projectId} not found`);
  return new Uint8Array(decryptBytes(sealed));
}

/**
 * Seal a continuation for storage.
 * @param token - Run's continuation.
 * @returns The ciphertext, IV, and tag.
 */
export function sealContinuation(token: string): EncryptedSecret {
  return encryptSecret(token);
}

/**
 * Open a stored continuation.
 * @param sealed - What {@link sealContinuation} stored.
 * @returns Run's continuation, or `null` when it does not decrypt (tampered,
 *   or the encryption key changed).
 */
export function openContinuation(sealed: EncryptedSecret): string | null {
  try {
    return decryptBytes(sealed).toString("utf8");
  } catch {
    return null;
  }
}
