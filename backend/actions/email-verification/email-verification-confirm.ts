import { and, eq, isNull, ne } from "drizzle-orm";
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
} from "../../classes/AuditedAction";
import { hashVerificationToken } from "../../ops/EmailVerificationOps";
import { serializeSelf } from "../../ops/UserOps";
import { emailVerifications } from "../../schema/email_verifications";
import { users } from "../../schema/users";

/** The one refusal for a link that cannot be used, whatever the reason. */
const UNUSABLE =
  "This link has expired, was already used, or no longer matches your address. Sign in and send a new one from your account.";

/**
 * `email-verification:confirm` — follow an emailed link. The token is the proof:
 * whoever holds it read the mail sent to the address. It confirms a sign-up
 * address, or switches the account to the new address it was asked to change
 * to. No session is needed, because the link may be opened anywhere.
 *
 * The token works once and only for the address it was sent to; an expired,
 * used, unknown, or stale token all get the same refusal, so a token cannot be
 * probed. Every outstanding link for the same address is spent with it.
 */
export class EmailVerificationConfirm extends AuditedAction {
  name = "email-verification:confirm";
  description =
    "Confirm an email address with the token from a verification link. Confirms the sign-up address, or completes a change of address. Does not require a session; the token is the proof.";
  middleware = [RateLimitMiddleware];
  web = { route: "/email-verification/confirm", method: HTTP_METHOD.POST };
  inputs = z.object({
    token: secret(z.string().min(16).max(256)).describe(
      "The token from the verification link",
    ),
  });

  /**
   * @param tx - The transaction the confirmation and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (often signed out).
   * @returns The confirmed person, as they see themselves.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for a link that cannot be used.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<EmailVerificationConfirm>,
    connection: AuditedConnection,
  ) {
    const refuse = () =>
      new TypedError({
        message: UNUSABLE,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "token",
      });

    const [link] = await tx
      .select()
      .from(emailVerifications)
      .where(
        eq(emailVerifications.tokenHash, hashVerificationToken(params.token)),
      )
      .for("update");
    if (!link || link.consumedAt || link.expiresAt.getTime() <= Date.now()) {
      throw refuse();
    }
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, link.userId))
      .for("update");
    if (!user) throw refuse();

    const now = new Date();
    let updated = user;
    if (link.email === user.email) {
      if (!user.emailVerifiedAt) {
        [updated] = await tx
          .update(users)
          .set({ emailVerifiedAt: now })
          .where(eq(users.id, user.id))
          .returning();
      }
    } else if (link.email === user.pendingEmail) {
      const [taken] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, link.email), ne(users.id, user.id)))
        .limit(1);
      if (taken) {
        throw new TypedError({
          message:
            "That address belongs to another account now, so it cannot be yours. Your address is unchanged.",
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "token",
        });
      }
      [updated] = await tx
        .update(users)
        .set({ email: link.email, pendingEmail: null, emailVerifiedAt: now })
        .where(eq(users.id, user.id))
        .returning();
    } else {
      throw refuse();
    }

    await tx
      .update(emailVerifications)
      .set({ consumedAt: now })
      .where(
        and(
          eq(emailVerifications.userId, user.id),
          eq(emailVerifications.email, link.email),
          isNull(emailVerifications.consumedAt),
        ),
      );

    // A link is usually followed signed out; the person it proves is the actor.
    connection.metadata.auditUserId = user.id;
    connection.metadata.auditBefore = serializeSelf(user);
    connection.metadata.auditAfter = serializeSelf(updated);
    connection.metadata.auditTargetType = "user";
    connection.metadata.auditTargetPath = updated.email;
    connection.metadata.auditMetadata = {
      userId: user.id,
      email: link.email,
      changedAddress: link.email !== user.email,
    };
    return { user: serializeSelf(updated) };
  }
}
