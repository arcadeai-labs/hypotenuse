import { eq } from "drizzle-orm";
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
import { writeAuditLog } from "../ops/AuditOps";
import {
  issueVerification,
  sendVerificationAfterCommit,
  type VerificationMail,
} from "../ops/EmailVerificationOps";
import { emailInput, nameInput } from "../ops/InputOps";
import { serializeMembership } from "../ops/MembershipOps";
import {
  createOrganizationForOwner,
  personalOrganizationName,
  serializeOrganization,
} from "../ops/OrganizationOps";
import {
  createProjectForOwner,
  DEFAULT_PROJECT_NAME,
  serializeProject,
} from "../ops/ProjectOps";
import { hashPassword, serializeSelf } from "../ops/UserOps";
import { users } from "../schema/users";

/**
 * `user:create` — register an account. Tagged `isSignupAction` so Keryx's
 * `/oauth/authorize` page renders a "sign up" tab generated from this action's
 * Zod schema, which is why every field is `.describe()`d.
 *
 * Sign-up is also the tenancy bootstrap, in one transaction: the user, an
 * organization named after them with them as its owner, its first project
 * ("Default"), the project's reserved `admin` tag, and their admin grant. A
 * partial bootstrap would leave a tenant nobody can administer.
 *
 * The address starts unconfirmed: a link is mailed to it once the account
 * commits, and until it is followed the person cannot see or accept the
 * invitations addressed to it.
 */
export class UserCreate extends AuditedAction {
  name = "user:create";
  description =
    "Register a new user account with a name, email, and password. The email must be unique (case-insensitive) and the password at least 8 characters. Sign-up creates an organization named after the person, with them as its owner, and a first project in it where they are admin. Returns the user, the organization, the project, and the project membership.";
  mcp = { tool: false, isSignupAction: true };
  middleware = [RateLimitMiddleware];
  web = { route: "/user", method: HTTP_METHOD.PUT };
  inputs = z.object({
    name: nameInput("Your display name"),
    email: emailInput("Your email address (must be unique, case-insensitive)"),
    password: secret(
      z.string().min(8, "Password must be at least 8 characters"),
    ).describe("A password of at least 8 characters"),
  });

  /**
   * @param tx - The transaction the sign-up, the bootstrap, and every audit row share.
   * @param params - The validated sign-up inputs.
   * @param connection - The (anonymous) caller's connection; audit snapshots written here.
   * @returns The user, their organization, its first project, and their membership.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` if the email is already registered.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<UserCreate>,
    connection: AuditedConnection,
  ) {
    const [existingUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, params.email))
      .limit(1);
    if (existingUser) {
      throw new TypedError({
        message: "A user with that email already exists. Sign in instead.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "email",
      });
    }

    const [user] = await tx
      .insert(users)
      .values({
        name: params.name,
        email: params.email,
        password_hash: await hashPassword(params.password),
      })
      .returning();

    const { organization } = await createOrganizationForOwner(
      tx,
      user.id,
      personalOrganizationName(user.name),
    );
    const { project, membership } = await createProjectForOwner(
      tx,
      organization.id,
      user.id,
      DEFAULT_PROJECT_NAME,
    );

    connection.metadata.afterCommitData = {
      verificationMail: {
        to: user.email,
        name: user.name,
        token: await issueVerification(tx, user.id, user.email),
        kind: "sign-up",
      } satisfies VerificationMail,
    };

    const serializedUser = serializeSelf(user);
    const serializedOrganization = serializeOrganization(organization);
    const serializedProject = serializeProject(project);

    connection.metadata.auditUserId = user.id;
    connection.metadata.auditAfter = serializedUser;
    connection.metadata.auditTargetType = "user";
    connection.metadata.auditTargetPath = user.email;

    // The sign-up row is deliberately tenant-less: an account belongs to no
    // project. Its actor is the account it creates. The organization and
    // project are created inside shared ops helpers, which bypass their own
    // actions' auditing, so they are logged here on this same transaction — or
    // a tenant's log would open with no record of its creation. Those two are
    // the system's rows: nobody chose to create them, sign-up always does.
    await writeAuditLog(tx, {
      actorType: "system",
      organizationId: organization.id,
      action: "organization:create",
      targetType: "organization",
      targetPath: organization.slug,
      after: serializedOrganization,
      metadata: {
        organizationId: organization.id,
        name: organization.name,
        bootstrappedBy: "user:create",
        ownerUserId: user.id,
      },
    });
    await writeAuditLog(tx, {
      actorType: "system",
      organizationId: organization.id,
      projectId: project.id,
      action: "project:create",
      targetType: "project",
      targetPath: project.slug,
      after: serializedProject,
      metadata: {
        organizationId: organization.id,
        name: project.name,
        bootstrappedBy: "user:create",
        ownerUserId: user.id,
      },
    });

    return {
      user: serializedUser,
      organization: serializedOrganization,
      project: serializedProject,
      membership: serializeMembership(membership),
    };
  }

  /**
   * Mail the confirmation link, once the account and its token are committed.
   * @param _result - The response.
   * @param _params - The sign-up inputs.
   * @param connection - Carries the link in `afterCommitData`.
   */
  async afterCommit(
    _result: unknown,
    _params: ActionParams<UserCreate>,
    connection: AuditedConnection,
  ) {
    await sendVerificationAfterCommit(connection.metadata.afterCommitData);
  }
}
