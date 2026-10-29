import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentations inside.
import type {} from "../config/frontend";
import type {} from "../config/notifications";
import {
  type EmailVerification,
  emailVerifications,
} from "../schema/email_verifications";
import type { User } from "../schema/users";
import type { DbHandle } from "./DbOps";
import { getTransport } from "./NotificationOps";
import { escapeHtml, layout } from "./templates";

/** How long an emailed link works: one day. */
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** How soon another link may be sent to the same person. */
export const RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * The stored form of a token: its hex SHA-256. A token is 32 random bytes, so
 * an unsalted hash is not guessable, and the table never holds a working link.
 * @param token - The token from the link.
 * @returns Its hash.
 */
export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a link for an address: a fresh token, of which only the hash is stored.
 * Run it on the transaction that changes what needs verifying, and send the
 * mail with {@link sendVerificationEmail} after that commits.
 * @param tx - The open transaction (any handle, for a test minting a link).
 * @param userId - The person.
 * @param email - The address the link proves, lowercased.
 * @returns The plaintext token, for the email and nothing else.
 */
export async function issueVerification(
  tx: DbHandle,
  userId: number,
  email: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await tx.insert(emailVerifications).values({
    userId,
    email,
    tokenHash: hashVerificationToken(token),
    expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
  });
  return token;
}

/**
 * The most recent link sent to a person that has not been used, if it was
 * sent within the resend cooldown.
 * @param db - A database handle.
 * @param userId - The person.
 * @returns The recent link, or `undefined`.
 */
export async function recentVerification(
  db: DbHandle,
  userId: number,
): Promise<EmailVerification | undefined> {
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.userId, userId),
        isNull(emailVerifications.consumedAt),
        gt(
          emailVerifications.createdAt,
          new Date(Date.now() - RESEND_COOLDOWN_MS),
        ),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The link a verification email carries: the dashboard's `/verify-email` page,
 * which posts the token to `email-verification:confirm`.
 * @param token - The plaintext token.
 * @returns The absolute URL.
 */
export function verificationLink(token: string): string {
  return `${config.frontend.url.replace(/\/+$/, "")}/verify-email?token=${encodeURIComponent(token)}`;
}

/**
 * Mail a verification link. Sent directly rather than through the notification
 * table, which is project-scoped and per recipient: an address being proved
 * belongs to no project yet. With no `SMTP_HOST` it is logged instead, link
 * included, which is how a development machine follows it.
 * @param to - The address the link proves.
 * @param name - The person's display name.
 * @param token - The plaintext token.
 * @param kind - Whether this confirms a sign-up or a change of address.
 */
export async function sendVerificationEmail(
  to: string,
  name: string,
  token: string,
  kind: "sign-up" | "change",
): Promise<void> {
  const link = verificationLink(token);
  const heading =
    kind === "sign-up"
      ? "Confirm your email address"
      : "Confirm your new email address";
  const sentence =
    kind === "sign-up"
      ? "Follow this link to confirm this is your address. Until you do, you cannot see or accept invitations."
      : "Follow this link to make this your address on Hypotenuse. Your old address stays in place until you do.";
  const subject = `[Hypotenuse] ${heading}`;
  const text = `Hi ${name},\n\n${sentence}\n\n${link}\n\nThe link works once, for one day. If you did not ask for it, ignore this email.`;

  const mailer = getTransport();
  if (!mailer) {
    api.logger.info("verification email (log-only mode: SMTP_HOST is unset)", {
      to,
      subject,
      link,
    });
    return;
  }
  await mailer.sendMail({
    from: config.notifications.from,
    to,
    subject,
    text,
    html: layout({
      heading,
      bodyHtml: `<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(sentence)}</p><p>The link works once, for one day. If you did not ask for it, ignore this email.</p>`,
      actionLabel: "Confirm address",
      actionUrl: link,
    }),
  });
}

/** What an action that issues a link hands its `afterCommit`. */
export type VerificationMail = {
  to: string;
  name: string;
  token: string;
  kind: "sign-up" | "change";
};

/**
 * Send the verification mail a `runWithAudit` described in `afterCommitData`,
 * once the token it carries is committed. Shared by every action that issues a
 * link; a no-op when that run issued none.
 * @param data - The connection's `afterCommitData`.
 */
export async function sendVerificationAfterCommit(
  data: Record<string, unknown> | undefined,
): Promise<void> {
  const mail = data?.verificationMail as VerificationMail | undefined;
  if (mail) {
    await sendVerificationEmail(mail.to, mail.name, mail.token, mail.kind);
  }
}

/** The refusal every invitation action gives an unconfirmed address. */
export const UNVERIFIED_EMAIL_MESSAGE =
  "Confirm your email address first: follow the link we mailed you, or send a new one from your account.";

/**
 * Refuse a person whose address is unconfirmed. Invitations are addressed by
 * email, so answering one is exactly as trustworthy as the claim to that
 * address — anyone can sign up as anybody's address, and only the mailed link
 * shows they read it.
 * @param user - The caller's row.
 * @throws {TypedError} 403 while `emailVerifiedAt` is unset.
 */
export function assertEmailVerified(user: Pick<User, "emailVerifiedAt">): void {
  if (!user.emailVerifiedAt) {
    throw new TypedError({
      message: UNVERIFIED_EMAIL_MESSAGE,
      type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    });
  }
}
