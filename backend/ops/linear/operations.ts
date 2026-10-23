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
  private: boolean;
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
    nodes { id key name private states(first: 100) { nodes { id name type position } } }
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
  labelIds?: string[];
  priority?: number;
  projectId?: string | null;
  estimate?: number;
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

/**
 * A comment outside any session thread: on an issue, or a reply on a
 * project's comment (`projectId` with `parentId`).
 */
export const CreateComment = operation<
  { commentCreate: { success: boolean; comment: { id: string; url: string } } },
  {
    input: {
      issueId?: string;
      projectId?: string;
      body: string;
      parentId?: string;
    };
  }
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
  /** Linear's page for the session. */
  url?: string | null;
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
    agentSession { id status url issue { id } }
  }
}`,
);

/** Start a session on a root comment. */
export const CreateAgentSessionOnComment = operation<
  {
    agentSessionCreateOnComment: {
      success: boolean;
      agentSession: LinearAgentSession | null;
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

/** A person, as the agent tools show them: their profile URL mentions them. */
export interface LinearPerson {
  id: string;
  name: string;
  url: string;
}

/** An issue in full, as `linear_get_issue` shows it. */
export interface LinearIssueDetail {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  estimate: number | null;
  team: { id: string; key: string; name: string };
  state: { id: string; name: string; type: string };
  project: { id: string; name: string; url: string } | null;
  parent: { id: string; identifier: string; title: string; url: string } | null;
  assignee: LinearPerson | null;
  delegate: LinearPerson | null;
  creator: LinearPerson | null;
  labels: { nodes: { id: string; name: string }[] };
  children: {
    nodes: {
      identifier: string;
      title: string;
      url: string;
      state: { name: string; type: string };
    }[];
  };
  relations: {
    nodes: {
      type: string;
      relatedIssue: { identifier: string; title: string; url: string };
    }[];
  };
  inverseRelations: {
    nodes: {
      type: string;
      issue: { identifier: string; title: string; url: string };
    }[];
  };
}

/** An issue with its people, sub-issues, and relations: `linear_get_issue`. */
export const GetIssueDetail = operation<
  { issue: LinearIssueDetail },
  { id: string }
>(
  "GetIssueDetail",
  `query GetIssueDetail($id: String!) {
  issue(id: $id) {
    id identifier title description url priority estimate
    team { id key name }
    state { id name type }
    project { id name url }
    parent { id identifier title url }
    assignee { id name url }
    delegate { id name url }
    creator { id name url }
    labels(first: 50) { nodes { id name } }
    children(first: 50) { nodes { identifier title url state { name type } } }
    relations(first: 50) { nodes { type relatedIssue { identifier title url } } }
    inverseRelations(first: 50) { nodes { type issue { identifier title url } } }
  }
}`,
);

/** A link in an issue's parent chain. */
export interface LinearAncestor {
  id: string;
  parent?: LinearAncestor | null;
}

/** What the scope rules read about an issue. */
export interface LinearIssueScope {
  id: string;
  identifier: string;
  url: string;
  team: { id: string; key: string; private: boolean };
  project: { id: string } | null;
  parent: LinearAncestor | null;
}

/**
 * The facts the agent tools' scope rules check an issue against: its team
 * (and whether it is private), its project, and five levels of parents.
 */
export const GetIssueScope = operation<
  { issue: LinearIssueScope },
  { id: string }
>(
  "GetIssueScope",
  `query GetIssueScope($id: String!) {
  issue(id: $id) {
    id identifier url
    team { id key private }
    project { id }
    parent { id parent { id parent { id parent { id parent { id } } } } }
  }
}`,
);

/** A comment as `linear_list_comments` shows it. */
export interface LinearCommentNode {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  parent: { id: string } | null;
  user: { id: string; name: string; url: string } | null;
}

/** One page of an issue's comments. */
export const ListIssueComments = operation<
  {
    issue: {
      id: string;
      identifier: string;
      url: string;
      comments: { nodes: LinearCommentNode[]; pageInfo: PageInfo };
    };
  },
  { id: string; first: number; after?: string | null }
>(
  "ListIssueComments",
  `query ListIssueComments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    id identifier url
    comments(first: $first, after: $after) {
      nodes { id body createdAt url parent { id } user { id name url } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`,
);

/** An issue in a list of search results. */
export interface LinearIssueSummary {
  identifier: string;
  title: string;
  url: string;
  priority: number;
  team: { key: string };
  state: { name: string; type: string };
}

/** Issues matching a filter: `linear_search_issues`. */
export const SearchIssues = operation<
  { issues: { nodes: LinearIssueSummary[] } },
  { filter: Record<string, unknown>; first: number }
>(
  "SearchIssues",
  `query SearchIssues($filter: IssueFilter, $first: Int!) {
  issues(filter: $filter, first: $first) {
    nodes { identifier title url priority team { key } state { name type } }
  }
}`,
);

/** The fields `issueCreate` takes from the agent tools. Never an assignee. */
export interface LinearIssueCreateInput {
  teamId: string;
  title: string;
  description?: string;
  labelIds?: string[];
  priority?: number;
  projectId?: string;
  parentId?: string;
  createAsUser?: string;
  displayIconUrl?: string;
}

/** Create an issue as the app, optionally attributed to a person. */
export const CreateIssue = operation<
  { issueCreate: { success: boolean; issue: LinearIssue } },
  { input: LinearIssueCreateInput }
>(
  "CreateIssue",
  `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      ${ISSUE_FIELDS}
    }
  }
}`,
);

/** Relate two issues. */
export const CreateIssueRelation = operation<
  {
    issueRelationCreate: {
      success: boolean;
      issueRelation: { id: string; type: string };
    };
  },
  { input: { issueId: string; relatedIssueId: string; type: string } }
>(
  "CreateIssueRelation",
  `mutation CreateIssueRelation($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success issueRelation { id type } }
}`,
);

/** A project in full, as `linear_get_project` shows it. */
export interface LinearProjectDetail {
  id: string;
  name: string;
  description: string;
  content: string | null;
  url: string;
  status: { id: string; name: string; type: string };
  lead: LinearPerson | null;
  teams: { nodes: { id: string; key: string; private: boolean }[] };
  issues: { nodes: { state: { type: string } }[] };
}

/** One project, with its teams and its issues' state types. */
export const GetProjectDetail = operation<
  { project: LinearProjectDetail },
  { id: string }
>(
  "GetProjectDetail",
  `query GetProjectDetail($id: String!) {
  project(id: $id) {
    id name description content url
    status { id name type }
    lead { id name url }
    teams(first: 50) { nodes { id key private } }
    issues(first: 250) { nodes { state { type } } }
  }
}`,
);

/** Whether a project has content yet: what a routing rule may match on. */
export const GetProjectContent = operation<
  { project: { id: string; content: string | null } },
  { id: string }
>(
  "GetProjectContent",
  `query GetProjectContent($id: String!) {
  project(id: $id) { id content }
}`,
);

/** A document's identity, and what it is attached to. */
export interface LinearDocument {
  id: string;
  title: string;
  url: string;
  project: { id: string } | null;
  issue: { id: string } | null;
}

/** A project's documents. */
export const ListProjectDocuments = operation<
  { project: { documents: { nodes: LinearDocument[] } } },
  { id: string }
>(
  "ListProjectDocuments",
  `query ListProjectDocuments($id: String!) {
  project(id: $id) {
    documents(first: 50) { nodes { id title url project { id } issue { id } } }
  }
}`,
);

/** One document. */
export const GetDocument = operation<
  { document: LinearDocument },
  { id: string }
>(
  "GetDocument",
  `query GetDocument($id: String!) {
  document(id: $id) { id title url project { id } issue { id } }
}`,
);

/** The workspace's project statuses. */
export const ListProjectStatuses = operation<{
  organization: {
    projectStatuses: { id: string; name: string; type: string }[];
  };
}>(
  "ListProjectStatuses",
  `query ListProjectStatuses {
  organization { projectStatuses { id name type } }
}`,
);

/** Write a project's content, summary, or status — never its lead or members. */
export const UpdateProject = operation<
  {
    projectUpdate: {
      success: boolean;
      project: { id: string; name: string; url: string };
    };
  },
  {
    id: string;
    input: { content?: string; description?: string; statusId?: string };
  }
>(
  "UpdateProject",
  `mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) {
  projectUpdate(id: $id, input: $input) { success project { id name url } }
}`,
);

/** Create a document on a project or an issue. */
export const CreateDocument = operation<
  { documentCreate: { success: boolean; document: LinearDocument } },
  {
    input: {
      title: string;
      content: string;
      projectId?: string;
      issueId?: string;
    };
  }
>(
  "CreateDocument",
  `mutation CreateDocument($input: DocumentCreateInput!) {
  documentCreate(input: $input) {
    success
    document { id title url project { id } issue { id } }
  }
}`,
);

/** Replace a document's content (and title). */
export const UpdateDocument = operation<
  { documentUpdate: { success: boolean; document: LinearDocument } },
  { id: string; input: { content?: string; title?: string } }
>(
  "UpdateDocument",
  `mutation UpdateDocument($id: String!, $input: DocumentUpdateInput!) {
  documentUpdate(id: $id, input: $input) {
    success
    document { id title url project { id } issue { id } }
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
  GetIssueDetail,
  GetIssueScope,
  ListIssueComments,
  SearchIssues,
  CreateIssue,
  CreateIssueRelation,
  GetProjectDetail,
  ListProjectDocuments,
  GetDocument,
  ListProjectStatuses,
  UpdateProject,
  CreateDocument,
  UpdateDocument,
] as const;
