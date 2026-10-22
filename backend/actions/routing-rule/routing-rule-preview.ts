import {
  type Action,
  type ActionParams,
  api,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { getIntegration } from "../../ops/IntegrationOps";
import {
  LinearGraphQLError,
  LinearIntegrationUnavailableError,
} from "../../ops/LinearOps";
import {
  booleanInput,
  type EligibilityQuery,
  evaluateRunners,
  RUNNER_REASON_SENTENCES,
  waitingCodeFor,
} from "../../ops/RoutingOps";
import { runnerOwners } from "../../ops/RunnerOps";
import {
  decideRepository,
  decideRole,
  fetchIssueSnapshot,
  type RepositoryTrace,
} from "../../ops/WorkRouteOps";

/**
 * `routing-rule:preview` — "what would happen if this issue were delegated
 * now?". Reads the issue from Linear, runs the project's real role selection
 * over it (and over `prompt`, as if it were the mention's text), and judges
 * every runner of the project against the work with the same conditions
 * `work:route` uses, giving each one it rules out its reason codes — the
 * codes a waiting turn carries on the session page. Asks Linear to rank the
 * candidate repositories only with `withRepository=true`, because that
 * spends the workspace's Linear budget. Writes nothing. Requires membership.
 */
export class RoutingRulePreview implements Action {
  name = "routing-rule:preview";
  description =
    "Preview how a Linear issue would be routed if it were delegated now: which routing rule matches and the role it picks, every runner of the project with whether it could take the work and, if not, why (offline, draining, paused, no_capacity, role_not_served, repository_missing, subscription_mismatch), and which repository would be used. Writes nothing. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/routing-rule/preview", method: HTTP_METHOD.GET };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose rules and runners to preview"),
    issue: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe("The Linear issue, by identifier (ENG-123) or id"),
    prompt: z
      .string()
      .max(10_000)
      .optional()
      .describe(
        "Text to route as if someone mentioned @hypotenuse with it, e.g. /manage plan the launch; omit to preview a delegation",
      ),
    withRepository: booleanInput
      .optional()
      .describe(
        "Also ask Linear to rank the candidate repositories (spends Linear API budget)",
      ),
  });

  /**
   * @param params - The project, the issue, and the options.
   * @returns The preview.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when Linear is
   *   not connected; `CONNECTION_ACTION_NOT_FOUND` when Linear has no such issue.
   */
  async run(params: ActionParams<RoutingRulePreview>) {
    const integration = await getIntegration(params.projectId, "linear");
    if (!integration || integration.status !== "active") {
      throw new TypedError({
        message: "Connect Linear to this project before previewing routing",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "projectId",
      });
    }
    const prompt = params.prompt?.trim() || null;
    let snapshot: Awaited<ReturnType<typeof fetchIssueSnapshot>>;
    try {
      snapshot = await fetchIssueSnapshot(integration, params.issue);
    } catch (e) {
      if (e instanceof LinearGraphQLError) {
        throw new TypedError({
          message: `Linear has no issue ${params.issue} that this workspace's app can see`,
          type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
        });
      }
      if (e instanceof LinearIntegrationUnavailableError) {
        throw new TypedError({
          message: "Linear is not connected to this project",
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "projectId",
        });
      }
      throw e;
    }
    const role = await decideRole(
      integration,
      params.projectId,
      snapshot,
      prompt === null ? "delegation" : "mention",
      prompt,
    );
    snapshot = role.snapshot;
    const decision = role.decision;

    const trace: RepositoryTrace = { candidates: [], suggestion: null };
    const withRepository = params.withRepository === true;
    // Without Linear's ranking, two candidates or more end in a question
    // only Linear could have avoided; the preview says it does not know.
    const repository = await decideRepository(
      {
        projectId: params.projectId,
        externalIssueId: snapshot.id,
        externalSessionId: null,
        repository: null,
      },
      integration,
      decision.role,
      snapshot,
      decision,
      trace,
      withRepository,
    );
    const resolved =
      repository.kind === "resolved" ? repository.repository : undefined;
    const query: EligibilityQuery = {
      projectId: params.projectId,
      role: decision.role,
      repository: resolved,
      issue: snapshot,
    };
    const evaluations = await evaluateRunners(api.db.db, query);
    const owners = await runnerOwners(evaluations.map((e) => e.userId));
    return {
      preview: {
        issue: {
          id: snapshot.id,
          identifier: snapshot.identifier,
          title: snapshot.title,
          url: snapshot.url,
          teamKey: snapshot.teamKey,
          labels: snapshot.labels,
          project: snapshot.project
            ? { id: snapshot.project.id, name: snapshot.project.name }
            : null,
        },
        origin: prompt === null ? "delegation" : "mention",
        matchedRuleId: decision.rule?.id ?? null,
        matchedRuleName: decision.rule?.name ?? null,
        role: decision.role,
        candidates: evaluations.map((e) => {
          const owner = owners.get(e.userId);
          return {
            runnerId: e.runnerId,
            name: e.name,
            owner: owner ? { id: owner.id, name: owner.name } : null,
            eligible: e.eligible,
            reasons: e.reasons.map((code) => ({
              code,
              message: RUNNER_REASON_SENTENCES[code],
            })),
          };
        }),
        waitingCode: waitingCodeFor(evaluations),
        repository: {
          candidates: trace.candidates,
          repository: resolved ?? null,
          pinnedByRule: Boolean(decision.rule?.repository),
          suggestion: trace.suggestion,
          // Null: several candidates, and Linear was not asked to rank them.
          wouldElicit:
            repository.kind === "ask" ? (withRepository ? true : null) : false,
          // A worker with no candidate waits for a runner with a checkout.
          waitsForRepository: repository.kind === "unresolved",
          askedLinear: withRepository && trace.candidates.length > 1,
        },
      },
    };
  }
}
