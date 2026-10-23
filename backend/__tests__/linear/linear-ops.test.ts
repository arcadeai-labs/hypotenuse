import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { api } from "keryx";
import { LinearGraphQLError, linearRequest } from "../../ops/LinearOps";
import {
  CreateAgentActivity,
  CreateAgentSessionOnComment,
  CreateAgentSessionOnIssue,
  CreateComment,
  CreateDocument,
  CreateIssue,
  CreateIssueRelation,
  GetAgentSessionActivities,
  GetComment,
  GetDocument,
  GetInstallationIdentity,
  GetIssue,
  GetIssueDetail,
  GetIssueScope,
  GetOrganization,
  GetProjectDetail,
  GetViewer,
  IssueRepositorySuggestions,
  LINEAR_OPERATIONS,
  type LinearOperation,
  ListIssueComments,
  ListLabels,
  ListProjectDocuments,
  ListProjectStatuses,
  ListProjects,
  ListTeams,
  ListWorkflowStates,
  SearchIssues,
  UpdateAgentSession,
  UpdateDocument,
  UpdateIssue,
  UpdateProject,
} from "../../ops/linear/operations";
import type { Integration } from "../../schema/integrations";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { FINEAR_FIXTURES, FINEAR_PRIMARY_KEY, useFinear } from "./finear";
import { integrationRow } from "./helpers";

/** The backend workspace. */
const BACKEND = join(import.meta.dir, "..", "..");

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let integration: Integration;
let issue: { id: string; identifier: string };

beforeAll(async () => {
  const landed = await linear.install(
    universe.projectId,
    universe.peach.sessionId,
  );
  expect(landed.searchParams.get("connected")).toBe("1");
  integration = await integrationRow(universe.projectId);
  const created = await linear.graphql<{
    issueCreate: { issue: { id: string; identifier: string } };
  }>(
    FINEAR_PRIMARY_KEY,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }`,
    {
      input: {
        teamId: FINEAR_FIXTURES.primary.team,
        title: "Retry webhook ingress",
        description: "Key retries on Linear-Delivery.",
      },
    },
  );
  expect(created.errors).toBeUndefined();
  issue = created.data!.issueCreate.issue;
}, HOOK_TIMEOUT);

/** Every operation name this suite has run successfully. */
const executed = new Set<string>();

/**
 * Run one operation as the app, recording that it ran.
 * @param op - The operation.
 * @param variables - Its variables.
 * @returns Its data.
 */
async function run<T, V>(op: LinearOperation<T, V>, variables: V): Promise<T> {
  const data = await linearRequest(integration, op, variables);
  executed.add(op.name);
  return data;
}

describe("every Linear operation document executes against finear", () => {
  test("identity: viewer, organization, and the install query", async () => {
    const { viewer } = await run(GetViewer, {});
    expect(viewer.id).toBe(integration.externalAppUserId);
    expect(viewer.app).toBe(true);
    const { organization } = await run(GetOrganization, {});
    expect(organization.id).toBe(FINEAR_FIXTURES.primary.organization);
    const identity = await run(GetInstallationIdentity, {});
    expect(identity.teams.nodes.map((t) => t.key)).toEqual(["ENG"]);
  });

  test("catalog: teams, one team's states, projects, labels", async () => {
    const { teams } = await run(ListTeams, { after: null });
    expect(teams.nodes[0].states.nodes.length).toBe(3);
    const { team } = await run(ListWorkflowStates, {
      teamId: FINEAR_FIXTURES.primary.team,
    });
    expect(team.states.nodes.map((s) => s.type).sort()).toEqual([
      "backlog",
      "completed",
      "started",
    ]);
    expect((await run(ListProjects, {})).projects.nodes).toBeArray();
    expect((await run(ListLabels, {})).issueLabels.nodes).toBeArray();
  });

  test("issues: read by identifier, move state, comment", async () => {
    const read = await run(GetIssue, { id: issue.identifier });
    expect(read.issue.id).toBe(issue.id);
    expect(read.issue.team.key).toBe("ENG");
    const moved = await run(UpdateIssue, {
      id: issue.id,
      input: { stateId: FINEAR_FIXTURES.primary.started },
    });
    expect(moved.issueUpdate.issue.state.type).toBe("started");
    expect(read.issue.parent).toBeNull();
    expect(read.issue.project).toBeNull();
    const comment = await run(CreateComment, {
      input: { issueId: issue.id, body: "Picking this up." },
    });
    expect(comment.commentCreate.success).toBe(true);
    const readBack = await run(GetComment, {
      id: comment.commentCreate.comment.id,
    });
    expect(readBack.comment.body).toBe("Picking this up.");

    const onComment = await run(CreateAgentSessionOnComment, {
      input: { commentId: comment.commentCreate.comment.id },
    });
    expect(onComment.agentSessionCreateOnComment.agentSession?.issue?.id).toBe(
      issue.id,
    );
  });

  test("agent sessions: create, post an activity by client id, update, read back, suggest a repository", async () => {
    const created = await run(CreateAgentSessionOnIssue, {
      input: { issueId: issue.id },
    });
    const session = created.agentSessionCreateOnIssue.agentSession;
    expect(session.issue?.id).toBe(issue.id);

    const clientId = crypto.randomUUID();
    const activity = await run(CreateAgentActivity, {
      input: {
        id: clientId,
        agentSessionId: session.id,
        content: { type: "thought", body: "Reading the webhook handler." },
      },
    });
    expect(activity.agentActivityCreate.agentActivity.id).toBe(clientId);

    const updated = await run(UpdateAgentSession, {
      id: session.id,
      input: {
        summary: "Retry webhook ingress",
        addedExternalUrls: [
          { label: "Hypotenuse", url: "https://www.hypotenuse.cloud/s/1" },
        ],
      },
    });
    expect(updated.agentSessionUpdate.success).toBe(true);

    const history = await run(GetAgentSessionActivities, { id: session.id });
    expect(history.agentSession.activities.nodes).toContainEqual(
      expect.objectContaining({
        id: clientId,
        content: expect.objectContaining({
          __typename: "AgentActivityThoughtContent",
          body: "Reading the webhook handler.",
        }),
      }),
    );

    const suggestions = await run(IssueRepositorySuggestions, {
      issueId: issue.id,
      agentSessionId: session.id,
      candidateRepositories: [
        {
          hostname: "github.com",
          repositoryFullName: "arcadeai-labs/hypotenuse",
        },
      ],
    });
    expect(suggestions.issueRepositorySuggestions.suggestions).toBeArray();
  });

  test("agent tools: issue detail and scope, comments, search, create, relate", async () => {
    const detail = await run(GetIssueDetail, { id: issue.identifier });
    expect(detail.issue.identifier).toBe(issue.identifier);
    expect(detail.issue.creator?.url).toStartWith("https://");
    const scope = await run(GetIssueScope, { id: issue.identifier });
    expect(scope.issue.team.id).toBe(FINEAR_FIXTURES.primary.team);
    expect(scope.issue.team.private).toBe(false);

    const comments = await run(ListIssueComments, {
      id: issue.id,
      first: 25,
      after: null,
    });
    expect(comments.issue.comments.nodes.length).toBeGreaterThan(0);

    const found = await run(SearchIssues, {
      filter: {
        and: [
          {
            or: [
              { title: { containsIgnoreCase: "retry webhook" } },
              { description: { containsIgnoreCase: "retry webhook" } },
            ],
          },
          { team: { id: { eq: FINEAR_FIXTURES.primary.team } } },
          { state: { type: { neq: "canceled" } } },
        ],
      },
      first: 25,
    });
    expect(found.issues.nodes.map((i) => i.identifier)).toContain(
      issue.identifier,
    );

    const child = await run(CreateIssue, {
      input: {
        teamId: FINEAR_FIXTURES.primary.team,
        title: "Split the retry key",
        description: "A part of the parent.",
        parentId: issue.id,
        priority: 2,
        createAsUser: "Peach via Hypotenuse",
        displayIconUrl: "https://hypotenuse.example/favicon.svg",
      },
    });
    expect(child.issueCreate.issue.parent?.id).toBe(issue.id);
    const relation = await run(CreateIssueRelation, {
      input: {
        issueId: child.issueCreate.issue.id,
        relatedIssueId: issue.id,
        type: "related",
      },
    });
    expect(relation.issueRelationCreate.issueRelation.type).toBe("related");
  });

  test("agent tools: projects, project statuses, and documents", async () => {
    const statuses = await run(ListProjectStatuses, {});
    const planned = statuses.organization.projectStatuses[0]!;
    const made = await linear.graphql<{
      projectCreate: { project: { id: string } };
    }>(
      FINEAR_PRIMARY_KEY,
      `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }`,
      {
        input: {
          name: "Webhook hardening",
          teamIds: [FINEAR_FIXTURES.primary.team],
          statusId: planned.id,
        },
      },
    );
    expect(made.errors).toBeUndefined();
    const projectId = made.data!.projectCreate.project.id;

    const updated = await run(UpdateProject, {
      id: projectId,
      input: { content: "# PRD", description: "Harden ingress." },
    });
    expect(updated.projectUpdate.success).toBe(true);
    const detail = await run(GetProjectDetail, { id: projectId });
    expect(detail.project.content).toBe("# PRD");
    expect(detail.project.teams.nodes[0]?.id).toBe(
      FINEAR_FIXTURES.primary.team,
    );

    // finear has no documents: the harness's stand-in answers once finear
    // has validated each document against Linear's schema.
    const doc = await run(CreateDocument, {
      input: { title: "PRD", content: "# PRD", projectId },
    });
    const id = doc.documentCreate.document.id;
    expect((await run(GetDocument, { id })).document.project?.id).toBe(
      projectId,
    );
    await run(UpdateDocument, { id, input: { content: "# PRD v2" } });
    expect(linear.documents.get(id)?.content).toBe("# PRD v2");
    const listed = await run(ListProjectDocuments, { id: projectId });
    expect(listed.project.documents.nodes.map((d) => d.id)).toEqual([id]);
  });

  test("a GraphQL error is a LinearGraphQLError carrying Linear's message", async () => {
    await expect(
      linearRequest(integration, GetIssue, { id: "ENG-999999" }),
    ).rejects.toBeInstanceOf(LinearGraphQLError);
  });

  test("the set executed is exactly the set declared", () => {
    expect([...executed].sort()).toEqual(
      LINEAR_OPERATIONS.map((op) => op.name).sort(),
    );
  });
  test("LC-SES-22 LC-SES-19 LC-DEL-05 what no product path uses: reading a session back, its links, and delegate filters", async () => {
    // Declared and proven against Linear's schema above, but nothing calls
    // them: history and links come from the server's own mirror, never read
    // back.
    const glob = new Bun.Glob("{actions,ops,initializers}/**/*.ts");
    const callers: string[] = [];
    for await (const file of glob.scan({ cwd: BACKEND })) {
      if (file === "ops/linear/operations.ts") continue;
      const text = await Bun.file(join(BACKEND, file)).text();
      if (text.includes("GetAgentSessionActivities")) {
        callers.push(`${file}: GetAgentSessionActivities`);
      }
      // Nor is an issue filtered by its delegate: the dashboard counts
      // delegations from the mirror, and the tools search by text and team.
      if (/delegatedIssues|delegate:\s*\{/.test(text)) {
        callers.push(`${file}: delegate filter`);
      }
    }
    expect(callers).toEqual([]);
    for (const op of LINEAR_OPERATIONS) {
      expect(op.query, op.name).not.toMatch(/\bexternal(Links|Urls)\b/);
    }
  });
});
