import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { type ActionResponse, api, config } from "keryx";
import type { EmailVerificationConfirm } from "../../actions/email-verification/email-verification-confirm";
import type { InviteCreate } from "../../actions/invite/invite-create";
import type { InviteListPending } from "../../actions/invite/invite-list-pending";
import type { MeView } from "../../actions/me";
import type { UserCreate } from "../../actions/user";
import { resetNotificationTransport } from "../../ops/NotificationOps";
import { auditLogs } from "../../schema/audit_logs";
import { emailVerifications } from "../../schema/email_verifications";
import { users } from "../../schema/users";
import {
  type FakeSmtpServer,
  startFakeSmtpServer,
  verificationTokenIn,
} from "../fixtures/smtp";
import {
  buildTestUniverse,
  call,
  createUserAndLogin,
  HOOK_TIMEOUT,
  TEST_PASSWORD,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * Email verification, and the property it exists for: **an invitation goes to
 * whoever reads the mailbox, not whoever typed the address first.** Invites are
 * addressed by email, so until a person follows a link mailed to their address
 * they cannot see or answer one, and changing an address waits for the new one
 * to be proven. Every link here is read out of a message the real nodemailer
 * transport delivered to an in-process SMTP server.
 */

let u: TestUniverse;
let smtp: FakeSmtpServer;

beforeAll(async () => {
  u = await buildTestUniverse();
  smtp = startFakeSmtpServer();
  config.notifications.smtpHost = "127.0.0.1";
  config.notifications.smtpPort = smtp.port;
  resetNotificationTransport();
}, HOOK_TIMEOUT);

afterAll(async () => {
  smtp?.stop();
  config.notifications.smtpHost = "";
  resetNotificationTransport();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * The token in the newest verification mail sent to an address.
 * @param to - The recipient.
 * @returns The token, or `undefined` when no such mail arrived.
 */
function tokenMailedTo(to: string): string | undefined {
  const mail = smtp.received.findLast(
    (m) => m.to.includes(to) && m.subject.includes("Confirm your"),
  );
  return mail ? verificationTokenIn(mail) : undefined;
}

/**
 * An error envelope without the parts that differ per request (`timestamp`),
 * so two refusals can be compared whole.
 * @param body - A response body.
 * @returns The error, minus its timestamp.
 */
function refusal(body: { error?: object }) {
  const { timestamp: _, ...rest } = (body.error ?? {}) as Record<
    string,
    unknown
  >;
  return rest;
}

/**
 * Follow a link, signed out, the way the `/verify-email` page does.
 * @param token - The token from the link.
 * @returns The status and body.
 */
async function confirm(token: string) {
  return await call<ActionResponse<EmailVerificationConfirm>>(
    u.url,
    null,
    "POST",
    "/email-verification/confirm",
    { token },
  );
}

/**
 * The caller as `me:view` reports them.
 * @param user - Who.
 * @returns Their own serialized row.
 */
async function me(user: TestUser) {
  const res = await call<ActionResponse<MeView>>(u.url, user, "GET", "/me");
  return res.body.user;
}

/**
 * Invite an address into Castle as Peach.
 * @param email - The invitee's address.
 * @returns The invite's id.
 */
async function inviteToCastle(email: string): Promise<number> {
  const res = await call<ActionResponse<InviteCreate>>(
    u.url,
    u.peach,
    "PUT",
    `/organization/${u.organizationId}/invite`,
    { inviteeEmail: email, projectId: u.projectId, tagIds: [] },
  );
  expect(res.status).toBe(200);
  return res.body.invite.id;
}

/**
 * The pending-invite list as a person sees it.
 * @param user - Who.
 * @returns The list response.
 */
async function pendingFor(user: TestUser) {
  return (
    await call<ActionResponse<InviteListPending>>(
      u.url,
      user,
      "GET",
      "/invites/pending",
    )
  ).body;
}

describe("sign-up", () => {
  test("mails a link, and nobody can answer an invitation until it is followed", async () => {
    const inviteId = await inviteToCastle("rosalina@comet.observatory");

    // Anyone can sign up as the address; that alone proves nothing.
    const squatter = await createUserAndLogin(
      u.url,
      "Rosalina",
      "rosalina@comet.observatory",
      TEST_PASSWORD,
      { verified: false },
    );
    expect(await me(squatter)).toMatchObject({
      emailVerified: false,
      pendingEmail: null,
    });

    const listed = await pendingFor(squatter);
    expect(listed.invites).toEqual([]);
    expect(listed.emailVerified).toBe(false);

    // Accept and reject refuse identically, whether or not the invite exists.
    const accept = await call(
      u.url,
      squatter,
      "POST",
      `/invite/${inviteId}/accept`,
    );
    const reject = await call(
      u.url,
      squatter,
      "POST",
      `/invite/${inviteId}/reject`,
    );
    const nonexistent = await call(
      u.url,
      squatter,
      "POST",
      "/invite/999999/accept",
    );
    expect(accept.status).toBe(403);
    expect(reject.status).toBe(403);
    expect(nonexistent.status).toBe(403);
    expect(refusal(nonexistent.body)).toEqual(refusal(accept.body));

    // Whoever reads the mailbox follows the link; then the invitation is theirs.
    const token = tokenMailedTo("rosalina@comet.observatory");
    expect(token).toBeDefined();
    const confirmed = await confirm(token!);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.user).toMatchObject({
      id: squatter.userId,
      emailVerified: true,
    });

    expect((await pendingFor(squatter)).invites.map((i) => i.id)).toEqual([
      inviteId,
    ]);
    const accepted = await call(
      u.url,
      squatter,
      "POST",
      `/invite/${inviteId}/accept`,
    );
    expect(accepted.status).toBe(200);
  });

  test("the sign-up response never carries the token, and the table stores only its hash", async () => {
    const res = await call<ActionResponse<UserCreate>>(
      u.url,
      null,
      "PUT",
      "/user",
      {
        name: "Captain Toad",
        email: "captain@toad.tracker",
        password: TEST_PASSWORD,
      },
    );
    expect(res.status).toBe(200);
    const token = tokenMailedTo("captain@toad.tracker");
    expect(token).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain(token!);

    const rows = await api.db.db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, res.body.user.id));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token!);
  });
});

describe("email-verification:confirm", () => {
  test("a used, expired, or unknown link all get the same refusal", async () => {
    const person = await createUserAndLogin(
      u.url,
      "Kamek",
      "kamek@magikoopa.academy",
      TEST_PASSWORD,
      { verified: false },
    );
    const token = tokenMailedTo(person.email)!;
    expect((await confirm(token)).status).toBe(200);
    const used = await confirm(token);
    const unknown = await confirm("x".repeat(43));
    expect(used.status).toBe(406);
    expect(refusal(unknown.body)).toEqual(refusal(used.body));

    // Expiry is a column, so it is written rather than waited for.
    const resent = await createUserAndLogin(
      u.url,
      "Kammy",
      "kammy@magikoopa.academy",
      TEST_PASSWORD,
      { verified: false },
    );
    const late = tokenMailedTo(resent.email)!;
    await api.db.db
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.userId, resent.userId));
    const expired = await confirm(late);
    expect(refusal(expired.body)).toEqual(refusal(used.body));
    expect((await me(resent)).emailVerified).toBe(false);
  });

  test("the audit row records the confirmation and never the token", async () => {
    const person = await createUserAndLogin(
      u.url,
      "Goombella",
      "goombella@university.goom",
      TEST_PASSWORD,
      { verified: false },
    );
    const token = tokenMailedTo(person.email)!;
    expect((await confirm(token)).status).toBe(200);
    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "email-verification:confirm"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(row.targetPath).toBe(person.email);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.before).toMatchObject({ emailVerified: false });
    expect(row.after).toMatchObject({ emailVerified: true });
  });
});

describe("changing your address", () => {
  test("the old address stays until the new one is proven, and only then do its invites appear", async () => {
    const person = await createUserAndLogin(
      u.url,
      "Pianta",
      "pianta@isle.delfino",
    );
    const inviteId = await inviteToCastle("pianta@sirena.beach");

    const refused = await call(u.url, person, "POST", "/user", {
      email: "pianta@sirena.beach",
    });
    expect(refused.status).toBe(406);
    expect(refused.body.error?.key).toBe("currentPassword");

    const asked = await call<{ user: { email: string; pendingEmail: string } }>(
      u.url,
      person,
      "POST",
      "/user",
      { email: "pianta@sirena.beach", currentPassword: TEST_PASSWORD },
    );
    expect(asked.status).toBe(200);
    expect(asked.body.user).toMatchObject({
      email: "pianta@isle.delfino",
      pendingEmail: "pianta@sirena.beach",
    });

    // Nothing is addressed to the new address yet, as far as this person can tell.
    expect((await pendingFor(person)).invites).toEqual([]);
    const signIn = (email: string) =>
      call(u.url, null, "PUT", "/session", { email, password: TEST_PASSWORD });
    expect((await signIn("pianta@isle.delfino")).status).toBe(200);
    expect((await signIn("pianta@sirena.beach")).status).not.toBe(200);

    const confirmed = await confirm(tokenMailedTo("pianta@sirena.beach")!);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.user).toMatchObject({
      email: "pianta@sirena.beach",
      pendingEmail: null,
      emailVerified: true,
    });
    expect((await signIn("pianta@sirena.beach")).status).toBe(200);
    expect((await signIn("pianta@isle.delfino")).status).not.toBe(200);
    expect((await pendingFor(person)).invites.map((i) => i.id)).toEqual([
      inviteId,
    ]);
  });

  test("asking for your current address back withdraws the change, and its link stops working", async () => {
    const person = await createUserAndLogin(u.url, "Noki", "noki@pinna.park");
    await call(u.url, person, "POST", "/user", {
      email: "noki@noki.bay",
      currentPassword: TEST_PASSWORD,
    });
    const token = tokenMailedTo("noki@noki.bay")!;

    // Withdrawing needs no password: it changes nothing anybody relies on.
    const back = await call<{ user: { pendingEmail: string | null } }>(
      u.url,
      person,
      "POST",
      "/user",
      { email: "noki@pinna.park" },
    );
    expect(back.status).toBe(200);
    expect(back.body.user.pendingEmail).toBeNull();

    expect((await confirm(token)).status).toBe(406);
    expect((await me(person)).email).toBe("noki@pinna.park");
  });

  test("an address someone else confirmed in the meantime cannot be taken over", async () => {
    const person = await createUserAndLogin(
      u.url,
      "Lubba",
      "lubba@comet.observatory",
    );
    await call(u.url, person, "POST", "/user", {
      email: "polari@comet.observatory",
      currentPassword: TEST_PASSWORD,
    });
    const token = tokenMailedTo("polari@comet.observatory")!;

    // The real owner signs up with the address before the link is followed.
    await createUserAndLogin(u.url, "Polari", "polari@comet.observatory");

    const taken = await confirm(token);
    expect(taken.status).toBe(406);
    const [row] = await api.db.db
      .select()
      .from(users)
      .where(eq(users.id, person.userId));
    expect(row.email).toBe("lubba@comet.observatory");
  });
});

describe("email-verification:resend", () => {
  test("sends a new link at most once a minute, and only when something needs confirming", async () => {
    const person = await createUserAndLogin(
      u.url,
      "Toadsworth",
      "toadsworth@peach.castle",
      TEST_PASSWORD,
      { verified: false },
    );
    const first = tokenMailedTo(person.email);

    const tooSoon = await call(u.url, person, "PUT", "/email-verification");
    expect(tooSoon.status).toBe(406);

    // The cooldown reads `createdAt`, so the earlier link is moved back in time.
    await api.db.db
      .update(emailVerifications)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 1000) })
      .where(eq(emailVerifications.userId, person.userId));
    const resent = await call<{ sentTo: string }>(
      u.url,
      person,
      "PUT",
      "/email-verification",
    );
    expect(resent.status).toBe(200);
    expect(resent.body.sentTo).toBe(person.email);
    const second = tokenMailedTo(person.email);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    // Either link works; following one spends both.
    expect((await confirm(first!)).status).toBe(200);
    expect((await confirm(second!)).status).toBe(406);
    const spent = await api.db.db
      .select()
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.userId, person.userId),
          eq(emailVerifications.email, person.email),
        ),
      );
    expect(spent.every((r) => r.consumedAt !== null)).toBe(true);

    const nothingToDo = await call(u.url, person, "PUT", "/email-verification");
    expect(nothingToDo.status).toBe(406);
  });

  test("requires a session", async () => {
    const res = await call(u.url, null, "PUT", "/email-verification");
    expect(res.status).toBe(401);
  });
});
