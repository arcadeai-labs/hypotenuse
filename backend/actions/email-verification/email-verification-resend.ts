import { eq } from "drizzle-orm";
import {
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  RateLimitMiddleware,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { SessionMiddleware } from "../../middleware/session";
import {
  issueVerification,
  recentVerification,
  sendVerificationAfterCommit,
  type VerificationMail,
} from "../../ops/EmailVerificationOps";
import { users } from "../../schema/users";

/**
 * `email-verification:resend` — mail a new link for whatever the signed-in
 * person still has to confirm: a pending change of address first, otherwise an
 * unconfirmed sign-up address. At most one a minute.
 */
export class EmailVerificationResend extends AuditedAction {
  name = "email-verification:resend";
  description =
    "Send a new email-verification link: to your pending new address if you asked to change it, otherwise to your unconfirmed address. At most one per minute. Requires an active session.";
  middleware = [RateLimitMiddleware, SessionMiddleware];
  web = { route: "/email-verification", method: HTTP_METHOD.PUT };
  inputs = z.object({});

  /**
   * @param tx - The transaction the new link and its audit row share.
   * @param _params - No inputs.
   * @param connection - The caller's connection.
   * @returns The address the link went to.
   * @throws {TypedError} 406 when nothing needs confirming, or a link went out under a minute ago.
   */
  async runWithAudit(
    tx: TxHandle,
    _params: ActionParams<EmailVerificationResend>,
    connection: AuditedConnection,
  ) {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, connection.session!.data.userId!))
      .for("update");
    const email =
      user?.pendingEmail ?? (user && !user.emailVerifiedAt ? user.email : null);
    if (!user || !email) {
      throw new TypedError({
        message: "Your address is already confirmed.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
    if (await recentVerification(tx, user.id)) {
      throw new TypedError({
        message:
          "A link went out less than a minute ago. Check your inbox (and spam) before asking for another.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }

    const token = await issueVerification(tx, user.id, email);
    connection.metadata.afterCommitData = {
      verificationMail: {
        to: email,
        name: user.name,
        token,
        kind: user.pendingEmail ? "change" : "sign-up",
      } satisfies VerificationMail,
    };
    connection.metadata.auditTargetType = "user";
    connection.metadata.auditTargetPath = user.email;
    connection.metadata.auditMetadata = { userId: user.id, sentTo: email };
    return { sentTo: email };
  }

  /**
   * Mail the link, once the new token is committed.
   * @param _result - The response.
   * @param _params - No inputs.
   * @param connection - Carries the token in `afterCommitData`.
   */
  async afterCommit(
    _result: unknown,
    _params: ActionParams<EmailVerificationResend>,
    connection: AuditedConnection,
  ) {
    await sendVerificationAfterCommit(connection.metadata.afterCommitData);
  }
}
