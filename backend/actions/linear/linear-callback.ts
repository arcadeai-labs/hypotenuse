import { and, eq, ne } from "drizzle-orm";
import {
  type ActionParams,
  config,
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
import {
  collectState,
  exchangeCode,
  type LinearCallbackError,
  type LinearTokenGrant,
  tokenColumns,
} from "../../ops/LinearOAuthOps";
import { postGraphQL, serializeLinearInstallation } from "../../ops/LinearOps";
import {
  GetInstallationIdentity,
  type LinearOrganization,
  type LinearViewer,
} from "../../ops/linear/operations";
import { getCallerTags, isAdmin } from "../../ops/MembershipOps";
import { linearInstallations } from "../../schema/linear_installations";

/** A refusal that becomes `?error=<code>` on the dashboard redirect. */
class CallbackRefusal extends TypedError {
  readonly code: LinearCallbackError;

  /**
   * @param code - The redirect's error code.
   */
  constructor(code: LinearCallbackError) {
    super({
      message: `Linear install refused: ${code}`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
    });
    this.code = code;
  }
}

/** Everything learned from Linear before the audited write. */
interface PreparedInstall {
  projectId: number;
  userId: number;
  grant: LinearTokenGrant;
  viewer: LinearViewer;
  organization: LinearOrganization;
  teamIds: string[];
}

/**
 * The install each in-flight callback is writing, keyed by its connection: the
 * action is one instance shared by every request, so an instance field would be
 * shared between two admins' callbacks.
 */
const pending = new WeakMap<AuditedConnection, PreparedInstall>();

/**
 * The dashboard page the browser lands on.
 * @param query - The query parameters to put on it.
 * @returns A 302 to `/settings/linear`.
 */
function redirectToSettings(query: Record<string, string>): Response {
  const url = new URL(
    `${config.cliAuth.appUrl.replace(/\/+$/, "")}/settings/linear`,
  );
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Cache-Control": "no-store" },
  });
}

/**
 * Whether a driver error is a unique violation, through Drizzle's wrapper.
 * @param e - What the insert threw.
 * @returns True for Postgres `23505`.
 */
function isUniqueViolation(e: unknown): boolean {
  let current: unknown = e;
  for (let depth = 0; depth < 6 && current; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * `linear:callback` — where Linear sends the admin's browser after the consent
 * screen. Takes the parked `state` (once), checks it belongs to the signed-in
 * person who started the install, exchanges the code with its PKCE verifier,
 * asks Linear who the app is and which workspace, and stores the installation.
 *
 * A browser hop: it never answers JSON. Every outcome is a 302 to the
 * dashboard's Settings → Linear, with `?connected=1` or `?error=<code>` (see
 * `LINEAR_CALLBACK_ERRORS`). Never an MCP tool, never wrapped by the CLI.
 * Audited: attaching a workspace to a project is an admin's decision.
 *
 * A refused install does **not** revoke the tokens it was just given. An
 * `actor=app` install is one per workspace, so revoking a token from a second
 * project's attempt would uninstall the app the first project is using.
 */
export class LinearCallback extends AuditedAction {
  name = "linear:callback";
  description =
    "The second leg of connecting Linear: Linear redirects the approving admin's browser here. Redirects to the dashboard.";
  middleware = [RateLimitMiddleware];
  web = { route: "/linear/callback", method: HTTP_METHOD.GET };
  inputs = z.object({
    code: secret(z.string().max(2048))
      .optional()
      .describe("The authorization code Linear issued"),
    state: secret(z.string().max(256))
      .optional()
      .describe("The state linear:connect parked"),
    error: z
      .string()
      .max(256)
      .optional()
      .describe("Linear's error code, when the admin declined"),
    error_description: z
      .string()
      .max(2048)
      .optional()
      .describe("Linear's description of the error"),
  });

  /**
   * Do everything that talks to Linear, then the audited write, then redirect.
   * @param params - The callback's query.
   * @param connection - The browser's connection.
   * @returns A 302 to the dashboard, whatever happened.
   */
  // @ts-expect-error A browser hop answers a redirect, not the base class's JSON result.
  override async run(
    params: ActionParams<LinearCallback>,
    connection: AuditedConnection,
  ): Promise<Response> {
    try {
      const prepared = await this.prepare(params, connection);
      pending.set(connection, prepared);
      await super.run(params, connection);
      return redirectToSettings({
        connected: "1",
        projectId: String(prepared.projectId),
      });
    } catch (e) {
      const code = e instanceof CallbackRefusal ? e.code : "exchange_failed";
      return redirectToSettings({ error: code });
    } finally {
      pending.delete(connection);
    }
  }

  /**
   * Check the state and trade the code for tokens and an identity.
   * @param params - The callback's query.
   * @param connection - The browser's connection.
   * @returns What the write needs.
   * @throws {CallbackRefusal} For every refusal.
   */
  private async prepare(
    params: ActionParams<LinearCallback>,
    connection: AuditedConnection,
  ): Promise<PreparedInstall> {
    const parked = params.state ? await collectState(params.state) : null;
    if (!parked) throw new CallbackRefusal("state_expired");
    if (connection.session?.data.userId !== parked.userId) {
      throw new CallbackRefusal("state_mismatch");
    }
    if (params.error) {
      throw new CallbackRefusal(
        params.error === "access_denied" ? "denied" : "exchange_failed",
      );
    }
    if (!params.code) throw new CallbackRefusal("exchange_failed");

    try {
      const grant = await exchangeCode(params.code, parked.codeVerifier);
      const reply = await postGraphQL(
        grant.accessToken,
        GetInstallationIdentity,
        {},
      );
      if (!reply.data) throw new Error("no identity");
      return {
        projectId: parked.projectId,
        userId: parked.userId,
        grant,
        viewer: reply.data.viewer,
        organization: reply.data.organization,
        teamIds: reply.data.teams.nodes.map((t) => t.id),
      };
    } catch {
      throw new CallbackRefusal("exchange_failed");
    }
  }

  /**
   * Store the installation: a new row, or fresh tokens on the project's
   * existing one (same id, back to `active`).
   * @param tx - The transaction the write and its audit row share.
   * @param _params - Unused: everything comes from the prepared install.
   * @param connection - The browser's connection.
   * @returns The stored installation.
   * @throws {CallbackRefusal} `forbidden`, `workspace_taken`, or `workspace_changed`.
   */
  async runWithAudit(
    tx: TxHandle,
    _params: ActionParams<LinearCallback>,
    connection: AuditedConnection,
  ) {
    const install = pending.get(connection);
    if (!install) throw new CallbackRefusal("state_expired");
    const { projectId, organization, viewer, grant } = install;

    if (!isAdmin(await getCallerTags(install.userId, projectId))) {
      throw new CallbackRefusal("forbidden");
    }

    const [existing] = await tx
      .select()
      .from(linearInstallations)
      .where(eq(linearInstallations.projectId, projectId))
      .for("update");
    if (
      existing &&
      existing.status !== "revoked" &&
      existing.organizationId !== organization.id
    ) {
      throw new CallbackRefusal("workspace_changed");
    }

    const [elsewhere] = await tx
      .select({ id: linearInstallations.id })
      .from(linearInstallations)
      .where(
        and(
          eq(linearInstallations.organizationId, organization.id),
          ne(linearInstallations.status, "revoked"),
          ne(linearInstallations.projectId, projectId),
        ),
      )
      .limit(1);
    if (elsewhere) throw new CallbackRefusal("workspace_taken");

    const values = {
      organizationId: organization.id,
      organizationName: organization.name,
      urlKey: organization.urlKey,
      appUserId: viewer.id,
      appUserName: viewer.displayName || viewer.name,
      appUserCapabilities: {
        app: viewer.app,
        isAssignable: viewer.isAssignable,
        isMentionable: viewer.isMentionable,
        supportsAgentSessions: viewer.supportsAgentSessions,
      },
      oauthClientId: config.linear.clientId,
      scopes: grant.scopes,
      ...tokenColumns(grant),
      connectedAt: new Date(),
      lastRefreshedAt: null,
      refreshFailedAt: null,
      refreshError: null,
      teamIds: install.teamIds,
      status: "active" as const,
      installedByUserId: install.userId,
      rateLimit: null,
    };

    let row: typeof linearInstallations.$inferSelect;
    try {
      [row] = existing
        ? await tx
            .update(linearInstallations)
            .set(values)
            .where(eq(linearInstallations.id, existing.id))
            .returning()
        : await tx
            .insert(linearInstallations)
            .values({ projectId, ...values })
            .returning();
    } catch (e) {
      // Two projects finishing an install of the same workspace at once: the
      // partial unique index decides, and the loser is told the truth.
      if (isUniqueViolation(e)) throw new CallbackRefusal("workspace_taken");
      throw e;
    }

    const serialized = serializeLinearInstallation(row);
    connection.metadata.auditBefore = existing
      ? serializeLinearInstallation(existing)
      : undefined;
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditProjectId = projectId;
    connection.metadata.auditTargetType = "linear-installation";
    connection.metadata.auditTargetPath = organization.urlKey;
    connection.metadata.auditMetadata = {
      organizationId: organization.id,
      reconnect: Boolean(existing),
    };
    return { installation: serialized };
  }
}
