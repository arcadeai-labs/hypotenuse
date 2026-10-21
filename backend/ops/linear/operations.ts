/**
 * Every GraphQL operation Hypotenuse sends to Linear, as a typed document.
 *
 * Hand-written rather than generated, because the agent surface is a Developer
 * Preview whose fields reach the schema before any SDK helper. The cost is that
 * nothing but execution checks a document against the schema — so
 * `__tests__/linear/linear-ops.test.ts` runs every document here against
 * finear, which validates against Linear's own pinned schema. A document added
 * here without a test there fails that suite's whole-set assertion.
 *
 * Each constant carries its result and variables types, so `linearRequest`
 * returns the right shape without a cast at the call site. Lists are bounded
 * with `first:` so no single query can approach Linear's complexity ceiling.
 */

/** A GraphQL document with its result and variables types attached. */
export interface LinearOperation<TResult, TVariables> {
  /** The operation name, logged on every call (variables never are). */
  name: string;
  /** The document text. */
  query: string;
  /** Phantom: the result type. Never set. */
  readonly __result?: TResult;
  /** Phantom: the variables type. Never set. */
  readonly __variables?: TVariables;
}

/**
 * Declare one operation.
 * @param name - The operation name; must match the name inside `query`.
 * @param query - The document text.
 * @returns The typed operation.
 */
function operation<TResult, TVariables = Record<string, never>>(
  name: string,
  query: string,
): LinearOperation<TResult, TVariables> {
  return { name, query };
}

/** A relay page's cursor. */
export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/** The variables every paged list takes. */
export interface PageVariables {
  after?: string | null;
}

/** The app user, as its own token sees itself. */
export interface LinearViewer {
  id: string;
  name: string;
  displayName: string;
  app: boolean;
  isAssignable: boolean;
  isMentionable: boolean;
  supportsAgentSessions: boolean;
}

/** `viewer` under the app's token: the agent's identity in this workspace. */
export const GetViewer = operation<{ viewer: LinearViewer }>(
  "GetViewer",
  `query GetViewer {
  viewer { id name displayName app isAssignable isMentionable supportsAgentSessions }
}`,
);

/** The workspace an integration lives in. */
export interface LinearOrganization {
  id: string;
  name: string;
  urlKey: string;
}

/** `organization`: the workspace id that keys webhook routing. */
export const GetOrganization = operation<{ organization: LinearOrganization }>(
  "GetOrganization",
  `query GetOrganization {
  organization { id name urlKey }
}`,
);

/**
 * Everything the install callback needs in one round trip: who the app is, which
 * workspace, and which teams it was granted.
 */
export const GetInstallationIdentity = operation<{
  viewer: LinearViewer;
  organization: LinearOrganization;
  teams: { nodes: { id: string; key: string }[]; pageInfo: PageInfo };
}>(
  "GetInstallationIdentity",
  `query GetInstallationIdentity {
  viewer { id name displayName app isAssignable isMentionable supportsAgentSessions }
  organization { id name urlKey }
  teams(first: 250) { nodes { id key } pageInfo { hasNextPage endCursor } }
}`,
);

/** A workflow state, as the catalog reports it. */
export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

/** A team with its workflow states. */
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  states: { nodes: LinearWorkflowState[] };
}

/** One page of the teams the app can see, each with its states. */
export const ListTeams = operation<
  { teams: { nodes: LinearTeam[]; pageInfo: PageInfo } },
  PageVariables
>(
  "ListTeams",
  `query ListTeams($after: String) {
  teams(first: 50, after: $after) {
    nodes { id key name states(first: 100) { nodes { id name type position } } }
    pageInfo { hasNextPage endCursor }
  }
}`,
);

/** One team's workflow states. */
export const ListWorkflowStates = operation<
  { team: { states: { nodes: LinearWorkflowState[] } } },
  { teamId: string }
>(
  "ListWorkflowStates",
  `query ListWorkflowStates($teamId: String!) {
  team(id: $teamId) { states(first: 100) { nodes { id name type position } } }
}`,
);

/** A project, with the teams it spans. */
export interface LinearProject {
  id: string;
  name: string;
  teams: { nodes: { id: string }[] };
}

/** One page of the projects the app can see. */
export const ListProjects = operation<
  { projects: { nodes: LinearProject[]; pageInfo: PageInfo } },
  PageVariables
>(
  "ListProjects",
  `query ListProjects($after: String) {
  projects(first: 100, after: $after) {
    nodes { id name teams(first: 50) { nodes { id } } }
    pageInfo { hasNextPage endCursor }
  }
}`,
);

/** A label; `team` is null for a workspace-wide label. */
export interface LinearLabel {
  id: string;
  name: string;
  team: { id: string } | null;
}

/** One page of the labels the app can see. */
export const ListLabels = operation<
  { issueLabels: { nodes: LinearLabel[]; pageInfo: PageInfo } },
  PageVariables
>(
  "ListLabels",
  `query ListLabels($after: String) {
  issueLabels(first: 250, after: $after) {
    nodes { id name team { id } }
    pageInfo { hasNextPage endCursor }
  }
}`,
);

/** An issue, as much of it as routing and prompts read. */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  team: { id: string; key: string };
  state: { id: string; name: string; type: string };
  project: { id: string; name: string } | null;
  parent: { id: string; identifier: string } | null;
  labels: { nodes: { id: string; name: string }[] };
  delegate: { id: string } | null;
}

const ISSUE_FIELDS = `id identifier title description url
    team { id key }
    state { id name type }
    project { id name }
    parent { id identifier }
    labels(first: 50) { nodes { id name } }
    delegate { id }`;

/** One issue by UUID or identifier (`ENG-123`). */
export const GetIssue = operation<{ issue: LinearIssue }, { id: string }>(
  "GetIssue",
  `query GetIssue($id: String!) {
  issue(id: $id) {
    ${ISSUE_FIELDS}
  }
}`,
);

/** A comment's text: what a mention said. */
export const GetComment = operation<
  { comment: { id: string; body: string } },
  { id: string }
>(
  "GetComment",
  `query GetComment($id: String!) {
  comment(id: $id) { id body }
}`,
);

/** The fields `updateIssue` may change. */
export interface LinearIssueUpdateInput {
  stateId?: string;
  delegateId?: string | null;
  title?: string;
  description?: string;
}

/** Move an issue's state, change its delegate, or edit its text. */
export const UpdateIssue = operation<
  { issueUpdate: { success: boolean; issue: LinearIssue } },
  { id: string; input: LinearIssueUpdateInput }
>(
  "UpdateIssue",
  `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      ${ISSUE_FIELDS}
    }
  }
}`,
);

/** A comment on an issue, outside any session thread. */
export const CreateComment = operation<
  { commentCreate: { success: boolean; comment: { id: string; url: string } } },
  { input: { issueId: string; body: string; parentId?: string } }
>(
  "CreateComment",
  `mutation CreateComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}`,
);

/** An activity's content, by type. */
export interface LinearActivityContent {
  __typename: string;
  body?: string;
  action?: string;
  parameter?: string;
  result?: string | null;
}

/** An agent activity. */
export interface LinearAgentActivity {
  id: string;
  createdAt: string;
  ephemeral: boolean;
  signal: string | null;
  content: LinearActivityContent;
}

const ACTIVITY_FIELDS = `id createdAt ephemeral signal
    content {
      __typename
      ... on AgentActivityThoughtContent { body }
      ... on AgentActivityPromptContent { body }
      ... on AgentActivityResponseContent { body }
      ... on AgentActivityErrorContent { body }
      ... on AgentActivityElicitationContent { body }
      ... on AgentActivityActionContent { action parameter result }
    }`;

/** The input `agentActivityCreate` takes. `id` is the outbox's client UUID. */
export interface LinearAgentActivityInput {
  id: string;
  agentSessionId: string;
  content: Record<string, unknown>;
  ephemeral?: boolean;
  signal?: string;
  signalMetadata?: Record<string, unknown>;
}

/**
 * Post one activity to a session. Always carries a client-generated `id`, which
 * is what makes a retried send idempotent.
 */
export const CreateAgentActivity = operation<
  {
    agentActivityCreate: {
      success: boolean;
      agentActivity: LinearAgentActivity;
    };
  },
  { input: LinearAgentActivityInput }
>(
  "CreateAgentActivity",
  `mutation CreateAgentActivity($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    success
    agentActivity {
      ${ACTIVITY_FIELDS}
    }
  }
}`,
);

/** An agent session's identity and status. */
export interface LinearAgentSession {
  id: string;
  status: string;
  issue: { id: string } | null;
}

/**
 * The fields of `agentSessionUpdate` Hypotenuse writes. Deliberately not
 * `externalLink` (deprecated; it overwrites every external URL) nor the
 * whole-list `externalUrls`: links are only ever added or removed, so a link
 * someone else put on the session survives.
 */
export interface LinearAgentSessionUpdateInput {
  summary?: string | null;
  plan?: { content: string; status: string }[] | null;
  addedExternalUrls?: { label: string; url: string }[];
  removedExternalUrls?: string[];
}

/** Update a session's summary, plan, or external links. */
export const UpdateAgentSession = operation<
  { agentSessionUpdate: { success: boolean } },
  { id: string; input: LinearAgentSessionUpdateInput }
>(
  "UpdateAgentSession",
  `mutation UpdateAgentSession($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success }
}`,
);

/** Start a session on an issue (the manager dispatching, say). */
export const CreateAgentSessionOnIssue = operation<
  {
    agentSessionCreateOnIssue: {
      success: boolean;
      agentSession: LinearAgentSession;
    };
  },
  { input: { issueId: string; externalLink?: string } }
>(
  "CreateAgentSessionOnIssue",
  `mutation CreateAgentSessionOnIssue($input: AgentSessionCreateOnIssue!) {
  agentSessionCreateOnIssue(input: $input) {
    success
    agentSession { id status issue { id } }
  }
}`,
);

/** Start a session on a root comment. */
export const CreateAgentSessionOnComment = operation<
  {
    agentSessionCreateOnComment: {
      success: boolean;
      agentSession: LinearAgentSession;
    };
  },
  { input: { commentId: string; externalLink?: string } }
>(
  "CreateAgentSessionOnComment",
  `mutation CreateAgentSessionOnComment($input: AgentSessionCreateOnComment!) {
  agentSessionCreateOnComment(input: $input) {
    success
    agentSession { id status issue { id } }
  }
}`,
);

/** One page of a session's activities, oldest first: the turn history. */
export const GetAgentSessionActivities = operation<
  {
    agentSession: {
      id: string;
      status: string;
      activities: { nodes: LinearAgentActivity[]; pageInfo: PageInfo };
    };
  },
  { id: string; after?: string | null }
>(
  "GetAgentSessionActivities",
  `query GetAgentSessionActivities($id: String!, $after: String) {
  agentSession(id: $id) {
    id
    status
    activities(first: 100, after: $after) {
      nodes {
        ${ACTIVITY_FIELDS}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`,
);

/** A repository Linear thinks an issue belongs in. */
export interface LinearRepositorySuggestion {
  repositoryFullName: string;
  hostname: string | null;
  confidence: number;
}

/** Ask Linear which of the candidate repositories an issue belongs in. */
export const IssueRepositorySuggestions = operation<
  {
    issueRepositorySuggestions: { suggestions: LinearRepositorySuggestion[] };
  },
  {
    issueId: string;
    agentSessionId?: string | null;
    candidateRepositories: { hostname: string; repositoryFullName: string }[];
  }
>(
  "IssueRepositorySuggestions",
  `query IssueRepositorySuggestions(
  $issueId: String!
  $agentSessionId: String
  $candidateRepositories: [CandidateRepository!]!
) {
  issueRepositorySuggestions(
    issueId: $issueId
    agentSessionId: $agentSessionId
    candidateRepositories: $candidateRepositories
  ) {
    suggestions { repositoryFullName hostname confidence }
  }
}`,
);

/** Every operation above, for the test that runs each against finear. */
export const LINEAR_OPERATIONS = [
  GetViewer,
  GetOrganization,
  GetInstallationIdentity,
  ListTeams,
  ListWorkflowStates,
  ListProjects,
  ListLabels,
  GetIssue,
  GetComment,
  UpdateIssue,
  CreateComment,
  CreateAgentActivity,
  UpdateAgentSession,
  CreateAgentSessionOnIssue,
  CreateAgentSessionOnComment,
  GetAgentSessionActivities,
  IssueRepositorySuggestions,
] as const;
