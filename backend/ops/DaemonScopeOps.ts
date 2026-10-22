import { eq, sql } from "drizzle-orm";
import { api, ErrorType, TypedError } from "keryx";
import type { DaemonScope } from "../middleware/daemonSessionScope";
import { type LinearWrite, workItems } from "../schema/work_items";
import { spendForTool } from "./LinearBucketOps";
import {
  catalogKey,
  type LinearCatalog,
  loadCatalog,
} from "./LinearCatalogOps";
import {
  LinearGraphQLError,
  type LinearRequestOptions,
  linearRequest,
} from "./LinearOps";
import {
  GetIssueScope,
  type LinearAncestor,
  type LinearIssueScope,
  type LinearOperation,
} from "./linear/operations";

/**
 * The target rules an agent tool applies after `DaemonSessionScopeMiddleware`
 * has established *whose* session a call is for: what, in Linear, the call
 * may touch. Every rule is checked against Linear's data, never against what
 * the agent says about it.
 *
 * | Rule | Passes when |
 * |---|---|
 * | `session-issue` | the target is the session's own issue |
 * | `readable` | the target's team is one the integration was granted (or a public team, when it may read every public team) |
 * | `managed` | manager only: the session's issue, a descendant of it (five levels of parents), an issue this session created, or an issue in the session issue's team |
 *
 * A target refusal is a 403 that says why — unlike the scope refusal, which
 * must say nothing — because the agent should learn what it may do instead.
 */

/** How many levels of parents `managed` follows. */
export const MANAGED_DEPTH = 5;

/** The tools whose writes create issues a manager session then manages. */
const ISSUE_CREATING_TOOLS = new Set([
  "linear_create_issue",
  "linear_create_sub_issue",
]);

/**
 * A 403 for a target the rules refuse.
 * @param message - Why, for the agent.
 * @returns The error.
 */
export function targetRefused(message: string): TypedError {
  return new TypedError({
    message,
    type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
  });
}

/**
 * A 406 for an input that names something wrong.
 * @param message - What, for the agent.
 * @returns The error.
 */
export function toolInputRefused(message: string): TypedError {
  return new TypedError({
    message,
    type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
  });
}

/**
 * A 404 for something Linear has no record of (or the app cannot see).
 * @param message - What, for the agent.
 * @returns The error.
 */
export function notFound(message: string): TypedError {
  return new TypedError({
    message,
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/**
 * Whether a Linear failure means "no such thing (that the app can see)".
 * @param e - What a Linear call threw.
 * @returns True for a not-found GraphQL error.
 */
export function isLinearNotFound(e: unknown): boolean {
  return (
    e instanceof LinearGraphQLError &&
    e.errors.some(
      (err) =>
        /not.?found|could not find|entity not found/i.test(err.message) ||
        err.extensions?.code === "NOT_FOUND" ||
        (err.extensions as { type?: string } | undefined)?.type ===
          "entity not found",
    )
  );
}

/**
 * One agent tool call's view of Linear: the session's scope, its Linear
 * calls (each spending a token from the integration's bucket first), the
 * memoized facts the rules read, and the turn's write ledger.
 */
export class ToolScope {
  private readonly issues = new Map<string, Promise<LinearIssueScope>>();
  private created: Promise<Set<string>> | null = null;
  private catalogRead: Promise<LinearCatalog> | null = null;

  /**
   * @param scope - What the middleware resolved.
   * @param tool - The MCP tool being called (for the ledger).
   */
  constructor(
    readonly scope: DaemonScope,
    readonly tool: string,
  ) {}

  /** The session. */
  get session() {
    return this.scope.session;
  }

  /** The session's role. */
  get role() {
    return this.scope.role;
  }

  /**
   * Run one Linear operation as the integration, after spending a token.
   * @param op - The operation.
   * @param variables - Its variables.
   * @param kind - A read waits up to 5 s for a token, a write up to 30 s.
   * @returns Its data.
   */
  async linear<T, V>(
    op: LinearOperation<T, V>,
    variables: V,
    kind: "read" | "write",
  ): Promise<T> {
    await spendForTool(this.scope.integration.id, kind);
    const options: LinearRequestOptions = { idempotent: kind === "read" };
    return linearRequest(this.scope.integration, op, variables, options);
  }

  /**
   * The integration's cached catalog of teams, projects, and labels; re-read
   * once when something is missing from it, in case it was cached before
   * that thing existed.
   * @param refresh - Drop the cached copy first.
   * @returns The catalog.
   */
  async catalog(refresh = false): Promise<LinearCatalog> {
    if (refresh) {
      await api.redis.redis.del(catalogKey(this.scope.integration.id));
      this.catalogRead = null;
    }
    this.catalogRead ??= (async () => {
      await spendForTool(this.scope.integration.id, "read");
      return loadCatalog(this.scope.integration);
    })();
    return this.catalogRead;
  }

  /**
   * An issue's scope facts, by identifier or id.
   * @param ref - `ENG-123` or an id.
   * @returns The facts.
   * @throws {TypedError} 404 when Linear has no such issue the app can read.
   */
  issue(ref: string): Promise<LinearIssueScope> {
    const key = ref.trim();
    let found = this.issues.get(key);
    if (!found) {
      found = this.linear(GetIssueScope, { id: key }, "read")
        .then((d) => d.issue)
        .catch((e: unknown) => {
          if (isLinearNotFound(e))
            throw notFound(`No issue ${key} that Hypotenuse can read.`);
          throw e;
        });
      this.issues.set(key, found);
    }
    return found;
  }

  /**
   * The session's own issue.
   * @returns Its scope facts.
   */
  sessionIssue(): Promise<LinearIssueScope> {
    return this.issue(this.session.externalIssueId);
  }

  /**
   * The issue a tool targets: the one named, or the session's own.
   * @param ref - What the agent passed, if anything.
   * @returns Its scope facts.
   */
  target(ref: string | undefined): Promise<LinearIssueScope> {
    return ref ? this.issue(ref) : this.sessionIssue();
  }

  /**
   * `session-issue`: the target must be the session's own issue.
   * @param target - The resolved target.
   * @throws {TypedError} 403.
   */
  assertSessionIssue(target: LinearIssueScope): void {
    if (target.id === this.session.externalIssueId) return;
    const own = this.session.issueIdentifier ?? "this session's issue";
    throw targetRefused(
      `${target.identifier} is not the issue you are working on (${own}); a worker may only change its own issue.`,
    );
  }

  /**
   * Whether a team is one the integration may read.
   * @param team - The team, with whether it is private (unknown counts as private).
   * @returns True when readable.
   */
  teamReadable(team: { id: string; private?: boolean }): boolean {
    const details = this.scope.integration.details;
    if (details.teamIds.includes(team.id)) return true;
    return details.canAccessAllPublicTeams && team.private === false;
  }

  /**
   * `readable`: the target's team must be one the integration may read.
   * @param team - The target's team.
   * @param what - What the target is, for the refusal.
   * @throws {TypedError} 403.
   */
  assertReadable(
    team: { id: string; key?: string; private?: boolean },
    what: string,
  ): void {
    if (this.teamReadable(team)) return;
    throw targetRefused(
      `${what} is in team ${team.key ?? team.id}, which this workspace did not grant Hypotenuse.`,
    );
  }

  /**
   * The ids of the issues this session's turns created, from every turn's
   * write ledger.
   * @returns The Linear ids.
   */
  createdIssueIds(): Promise<Set<string>> {
    this.created ??= this.ledger().then(
      (writes) =>
        new Set(
          writes
            .filter((w) => ISSUE_CREATING_TOOLS.has(w.tool))
            .map((w) => w.linearId),
        ),
    );
    return this.created;
  }

  /**
   * Every write this session's turns recorded, oldest first.
   * @returns The ledger entries.
   */
  async ledger(): Promise<LinearWrite[]> {
    const rows = await api.db.db
      .select({ writes: workItems.linearWrites })
      .from(workItems)
      .where(eq(workItems.agentSessionId, this.session.id))
      .orderBy(workItems.id);
    return rows.flatMap((r) => r.writes);
  }

  /**
   * `managed`: a manager may act on its session's issue, the issue's
   * descendants (five levels), issues the session created, and issues in the
   * session issue's team.
   * @param target - The resolved target.
   * @throws {TypedError} 403 for a worker, or a target outside those.
   */
  async assertManaged(target: LinearIssueScope): Promise<void> {
    if (this.role !== "manager") {
      throw targetRefused("Only a manager session may do that.");
    }
    if (await this.isManaged(target)) return;
    const own = this.session.issueIdentifier ?? "this session's issue";
    throw targetRefused(
      `${target.identifier} is not one you manage: it is not ${own}, a sub-issue of it, an issue this session created, or in ${own}'s team.`,
    );
  }

  /**
   * Whether {@link assertManaged} would pass.
   * @param target - The resolved target.
   * @returns True when managed.
   */
  async isManaged(target: LinearIssueScope): Promise<boolean> {
    if (this.role !== "manager") return false;
    const own = this.session.externalIssueId;
    if (target.id === own) return true;
    if (ancestorIds(target.parent).includes(own)) return true;
    if ((await this.createdIssueIds()).has(target.id)) return true;
    const sessionIssue = await this.sessionIssue();
    return target.team.id === sessionIssue.team.id;
  }

  /**
   * The worker or manager rule for changing an issue: `session-issue` for a
   * worker, `managed` for a manager.
   * @param target - The resolved target.
   */
  async assertMayChange(target: LinearIssueScope): Promise<void> {
    if (this.role === "worker") this.assertSessionIssue(target);
    else await this.assertManaged(target);
  }

  /**
   * Append a write to the live turn's ledger.
   * @param target - What was written, as a person reads it.
   * @param linearId - Its Linear id.
   */
  async recordWrite(target: string, linearId: string): Promise<void> {
    const entry: LinearWrite = {
      tool: this.tool,
      target,
      linearId,
      at: Date.now(),
    };
    await api.db.db
      .update(workItems)
      .set({
        linearWrites: sql`${workItems.linearWrites} || ${JSON.stringify([entry])}::jsonb`,
      })
      .where(eq(workItems.id, this.scope.item.id));
    this.created = null;
  }
}

/**
 * The ids up an issue's parent chain, nearest first.
 * @param parent - The issue's parent, with its own parents nested.
 * @returns At most {@link MANAGED_DEPTH} ids.
 */
export function ancestorIds(
  parent: LinearAncestor | null | undefined,
): string[] {
  const ids: string[] = [];
  let at = parent;
  while (at && ids.length < MANAGED_DEPTH) {
    ids.push(at.id);
    at = at.parent ?? null;
  }
  return ids;
}
