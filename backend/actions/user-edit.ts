import { and, eq, ne } from "drizzle-orm";
import {
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  RateLimitMiddleware,
  secret,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../classes/AuditedAction";
import { SessionMiddleware } from "../middleware/session";
import {
  issueVerification,
  sendVerificationAfterCommit,
  type VerificationMail,
} from "../ops/EmailVerificationOps";
import { emailInput, nameInput } from "../ops/InputOps";
import { checkPassword, hashPassword, serializeSelf } from "../ops/UserOps";
import { type User, users } from "../schema/users";

/**
 * `user:edit` — update your own account. The record edited comes from the
 * session, never from an id param: there is no shape of this request that lets
 * one user edit another.
 *
 * Its audit row carries no `projectId`, which is correct rather than an
 * oversight — an account is not project-scoped, so a password change has no
 * business appearing in a project's log.
 *
 * Changing the email or the password needs the current password, so a
 * borrowed session cannot lock its owner out. A new email does not replace the
 * old one: it waits in `pendingEmail` while a link is mailed to it, and the
 * address changes only when that link is followed (`email-verification:confirm`).
 * Asking for the current address back cancels a pending change.
 */
export class UserEdit extends AuditedAction {
  name = "user:edit";
  description =
    "Update your own account's name, email, and/or password. Requires an active session. Changing the email or password requires `currentPassword`. A new email is not applied until you follow the confirmation link mailed to it; until then it is returned as `pendingEmail`. The email must remain unique (case-insensitive) and the password must be at least 8 characters. Returns the updated user.";
  middleware = [RateLimitMiddleware, SessionMiddleware];
  web = { route: "/user", method: HTTP_METHOD.POST };
  inputs = z.object({
    name: nameInput("A new display name").optional(),
    email: emailInput(
      "A new email address (must be unique, case-insensitive)",
    ).optional(),
    password: secret(
      z.string().min(8, "Password must be at least 8 characters").optional(),
    ).describe("A new password of at least 8 characters"),
    currentPassword: secret(z.string().max(1024).optional()).describe(
      "Your current password; required to change the email or password",
    ),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The validated inputs (any of `name`, `email`, `password`).
   * @param connection - The caller's connection (session required).
   * @returns The updated user, never including the password hash.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` if the new email belongs to someone else, or `currentPassword` is missing or wrong for an email or password change.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<UserEdit>,
    connection: AuditedConnection,
  ) {
    const userId = connection.session!.data.userId!;

    const [existing] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for("update");

    if (!existing) {
      throw new TypedError({
        message: "User not found",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }

    connection.metadata.auditBefore = serializeSelf(existing);
    connection.metadata.auditTargetType = "user";
    connection.metadata.auditTargetPath = existing.email;

    const updates: Partial<
      Pick<User, "name" | "password_hash" | "pendingEmail">
    > = {};

    // Re-asking for the pending address changes nothing (its link is resent
    // by `email-verification:resend`), and asking for the current one back
    // withdraws a change, which needs no password.
    const changesEmail =
      params.email !== undefined &&
      params.email !== existing.email &&
      params.email !== existing.pendingEmail;
    if (changesEmail || params.password !== undefined) {
      if (
        !params.currentPassword ||
        !(await checkPassword(existing, params.currentPassword))
      ) {
        throw new TypedError({
          message:
            "Enter your current password to change your email or password.",
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "currentPassword",
        });
      }
    }

    if (params.name !== undefined) updates.name = params.name;

    if (params.email !== undefined && params.email === existing.email) {
      // Asking for the address you already have withdraws a pending change.
      if (existing.pendingEmail) updates.pendingEmail = null;
    } else if (changesEmail && params.email !== undefined) {
      const [conflict] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, params.email), ne(users.id, userId)))
        .limit(1);
      if (conflict) {
        throw new TypedError({
          message: "A user with that email already exists",
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "email",
        });
      }
      updates.pendingEmail = params.email;
      connection.metadata.afterCommitData = {
        verificationMail: {
          to: params.email,
          name: params.name ?? existing.name,
          token: await issueVerification(tx, userId, params.email),
          kind: "change",
        } satisfies VerificationMail,
      };
    }

    if (params.password !== undefined) {
      updates.password_hash = await hashPassword(params.password);
    }

    // An empty update is not an error — the frontend only sends changed fields,
    // and "nothing changed" should read back as the current user. It still sets
    // `auditAfter` before returning, so the row records an edit that changed
    // nothing rather than an edit that appears to have deleted the user.
    if (Object.keys(updates).length === 0) {
      const serialized = serializeSelf(existing);
      connection.metadata.auditAfter = serialized;
      return { user: serialized };
    }

    const [updated] = await tx
      .update(users)
      .set(updates)
      .where(eq(users.id, userId))
      .returning();

    const serialized = serializeSelf(updated);
    connection.metadata.auditAfter = serialized;
    return { user: serialized };
  }

  /**
   * Mail the link for a new address, once the pending change is committed.
   * @param _result - The response.
   * @param _params - The edit inputs.
   * @param connection - Carries the link in `afterCommitData`, when one was issued.
   */
  async afterCommit(
    _result: unknown,
    _params: ActionParams<UserEdit>,
    connection: AuditedConnection,
  ) {
    await sendVerificationAfterCommit(connection.metadata.afterCommitData);
  }
}
