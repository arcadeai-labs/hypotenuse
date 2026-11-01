import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import { api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/frontend";
import type {} from "../../config/platforms";
import {
  buildLinearManifest,
  clientNameProblem,
  LINEAR_SCOPES,
  linearAppCreationLink,
  webhookUrlProblem,
} from "../../ops/LinearManifestOps";
import { bodyForLinear } from "../../ops/LinearMarkdownOps";
import {
  LinearApiError,
  linearCall,
  linearGraphql,
  linearTokenRequest,
  stableUuid,
} from "../../ops/LinearOps";
import type { Channel } from "../../schema/channels";
import {
  type OutboxMessage,
  outboxMessages,
} from "../../schema/outbox_messages";
import { applyFallbacks, approvalLink } from "../surface";
import type {
  OpenInstallation,
  PlatformAdapter,
  RawInbound,
  SendResult,
  SurfaceContext,
} from "../types";
import { linearEventId, parseLinearDelivery } from "./events";

/**
 * **The Linear platform.** Every bot is its own Linear OAuth app, created by
 * a workspace admin from the pre-filled link Hypotenuse generates
 * (`ops/LinearManifestOps.ts`) and installed into a workspace by OAuth with
 * `actor=app` and PKCE. Delegating an issue to the bot, or mentioning it,
 * makes Linear open an **agent session**: a session is a conversation, and
 * the issue's Linear project (its team, when it has none) is the channel and
 * its memory.
 *
 * **Inbound** is `POST /api/webhooks/linear/<routingKey>`: one JSON body,
 * signed as `Linear-Signature: hex(HMAC-SHA256(webhook secret, raw body))`,
 * whose signed `webhookTimestamp` (epoch ms) must be within
 * `timestampToleranceSeconds` (60) of now
 * (https://linear.app/developers/webhooks). During a secret rotation the
 * previous secret verifies too. An installation that is not active is still
 * answered 200 (`acknowledgeWhileInactive`): Linear disables a webhook whose
 * deliveries keep failing. What each body means is `events.ts`.
 *
 * **Outbound**, by surface kind, as agent activities
 * (https://linear.app/developers/agent-interaction). Every
 * `agentActivityCreate` carries an id derived from the outbox row, so a retry
 * after a lost answer is recognized ("already exists" counts as sent).
 *
 * | Kind | Linear | Notes |
 * |---|---|---|
 * | `status` (priority `ack`) | `thought` | the acknowledgement, on the bucket's reserve, within Linear's ten seconds; a delegated issue's hygiene runs after it |
 * | `status` | ephemeral `thought` | Linear replaces it with the next activity |
 * | `plan` | `agentSessionUpdate(plan)`, and an `action` (with its `result`) for each step that finished since the last plan sent | the session's checklist: `inProgress`, `completed`, `canceled` |
 * | `message` | `response`, or `error` for a failure | ends what Linear shows as the agent's turn |
 * | `question` | `elicitation`; options as the `select` signal | the next `prompted` is the answer |
 * | `approval` | `elicitation` with the dashboard link; options `Approve #<id>` / `Deny #<id>` as the `select` signal when the binding lets the channel decide | |
 * | `stream` | — | Linear shows activities, not partial text: dropped at enqueue |
 *
 * | Linear answers | Then |
 * |---|---|
 * | `success` | `sent`, with the activity's id |
 * | "already exists" (`CONFLICT`) | `sent`: an earlier attempt landed |
 * | `RATELIMITED`, an empty bucket, a network error or 5xx | `retry`, after the wait Linear named |
 * | anything else | `undeliverable`, with Linear's message |
 */

/** The installation's non-secret settings. */
const installationSchema = z.object({
  clientId: z
    .string()
    .trim()
    .min(8)
    .max(200)
    .describe("The app's Client ID (Linear → Settings → API → the app)"),
  appUserName: z
    .string()
    .max(200)
    .optional()
    .describe("The app user's name in Linear, set by the install"),
  organizationName: z
    .string()
    .max(200)
    .optional()
    .describe("The workspace's name"),
  urlKey: z.string().max(200).optional().describe("The workspace's URL key"),
  scopes: z.array(z.string()).optional().describe("The scopes granted"),
  accessTokenExpiresAt: z
    .number()
    .nullable()
    .optional()
    .describe("When the access token expires, epoch ms"),
  teamAccess: z
    .object({
      canAccessAllPublicTeams: z.boolean(),
      teamIds: z.array(z.string()),
    })
    .optional()
    .describe("The teams the app may see, from Linear's PermissionChange"),
});

/** The installation's secrets. */
const credentialSchema = z.object({
  clientSecret: z.string().min(8).max(256).describe("The app's Client Secret"),
  webhookSecret: z
    .string()
    .min(8)
    .max(256)
    .describe("The app webhook's signing secret"),
  webhookSecretPrevious: z
    .string()
    .max(256)
    .optional()
    .describe("The signing secret before a rotation, still accepted"),
  accessToken: z
    .string()
    .max(4096)
    .optional()
    .describe("The app's access token, set by the install"),
  refreshToken: z
    .string()
    .max(4096)
    .optional()
    .describe("The app's refresh token, set by the install"),
});

/**
 * Compute Linear's webhook signature.
 * @param secret - The webhook secret.
 * @param bytes - The raw body.
 * @returns The hex HMAC-SHA256.
 */
export function linearSignature(secret: string, bytes: Uint8Array): string {
  return createHmac("sha256", secret).update(bytes).digest("hex");
}

/**
 * Compare two strings in constant time.
 * @param a - One.
 * @param b - The other.
 * @returns Whether they are equal.
 */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Create one agent activity. */
const ACTIVITY_CREATE = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success agentActivity { id } }
}`;

/** Whether an activity exists: a retry's first question. */
const ACTIVITY_EXISTS = `query AgentActivityExists($id: String!) {
  agentActivity(id: $id) { id }
}`;

/** Update a session: its plan. */
const SESSION_UPDATE = `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success }
}`;

/** Who the app is, and where it is installed. */
const VIEWER = `query Viewer {
  viewer { id name displayName }
  organization { id name urlKey }
}`;

/** An issue's state, and its team's workflow states. */
const ISSUE_STATES = `query IssueStates($id: String!) {
  issue(id: $id) {
    id
    state { id type }
    team { id states { nodes { id type position } } }
  }
}`;

/** Move an issue to a state. */
const ISSUE_MOVE = `mutation IssueMove($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

/** The bot's names in Linear, which no outbound text may mention. */
function selfNames(inst: OpenInstallation): string[] {
  return [String(inst.installation.config.appUserName ?? "")].filter(Boolean);
}

/**
 * The transcript page of a conversation, for a cut body's link.
 * @param conversationId - The conversation.
 * @returns An absolute URL.
 */
function transcriptLink(conversationId: number): string {
  return `${config.frontend.url.replace(/\/+$/, "")}/conversations/${conversationId}`;
}

/**
 * Post one activity.
 * @param inst - The installation.
 * @param id - The activity's client id.
 * @param sessionId - The session.
 * @param content - The activity's content.
 * @param extra - `ephemeral`, `signal`, `signalMetadata`.
 * @param reserved - Draw on the bucket's reserve.
 * @param retry - An earlier attempt may have landed: ask Linear first, since
 *   a session it ended (a `response`) refuses even a replay of its own end.
 * @returns The activity's id.
 */
async function createActivity(
  inst: OpenInstallation,
  id: string,
  sessionId: string,
  content: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  reserved = false,
  retry = false,
): Promise<string> {
  if (retry) {
    try {
      const found = await linearCall<{ agentActivity: { id: string } | null }>(
        inst,
        ACTIVITY_EXISTS,
        { id },
        { reserved },
      );
      if (found.agentActivity?.id === id) return id;
    } catch (e) {
      // Not found is the answer we expect when the earlier attempt was lost.
      if (!(e instanceof LinearApiError) || e.retryable) throw e;
    }
  }
  try {
    await linearCall(
      inst,
      ACTIVITY_CREATE,
      { input: { id, agentSessionId: sessionId, content, ...extra } },
      { reserved },
    );
  } catch (e) {
    if (e instanceof LinearApiError && e.alreadyDone) return id;
    throw e;
  }
  return id;
}

/**
 * **Issue hygiene**, once, when a delegated session is acknowledged: an issue
 * that is not yet started, completed, or canceled moves to its team's first
 * `started` state (the lowest `position`). Never the assignee. Never fails
 * the acknowledgement: what it could not do is logged.
 * @param inst - The installation.
 * @param issueId - The issue.
 */
async function issueHygiene(
  inst: OpenInstallation,
  issueId: string,
): Promise<void> {
  try {
    const { issue } = await linearCall<{
      issue: {
        state: { type: string } | null;
        team: {
          states: { nodes: { id: string; type: string; position: number }[] };
        } | null;
      } | null;
    }>(inst, ISSUE_STATES, { id: issueId });
    const type = issue?.state?.type;
    if (!issue || !type || ["started", "completed", "canceled"].includes(type))
      return;
    const started = (issue.team?.states.nodes ?? [])
      .filter((s) => s.type === "started")
      .sort((a, b) => a.position - b.position)[0];
    if (!started) return;
    await linearCall(inst, ISSUE_MOVE, {
      id: issueId,
      input: { stateId: started.id },
    });
  } catch (e) {
    api.logger.warn("Linear issue hygiene did not complete", {
      installationId: inst.installation.id,
      issueId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** One step of a plan row. */
interface PlanStep {
  seq: number;
  tool: string;
  state: "running" | "done" | "error";
}

/**
 * The steps of the newest plan row sent before this one in the same turn.
 * @param row - The plan row being sent.
 * @returns The steps Linear has already been told of.
 */
async function previousPlan(row: OutboxMessage): Promise<PlanStep[]> {
  const [prev] = await api.db.db
    .select({ payload: outboxMessages.payload })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.conversationId, row.conversationId),
        eq(outboxMessages.kind, "plan"),
        eq(outboxMessages.status, "sent"),
        eq(outboxMessages.supersedesKey, row.supersedesKey ?? ""),
        lt(outboxMessages.id, row.id),
      ),
    )
    .orderBy(desc(outboxMessages.id))
    .limit(1);
  return ((prev?.payload as { steps?: PlanStep[] } | undefined)?.steps ??
    []) as PlanStep[];
}

/** Linear's plan step status for a step's state. */
const PLAN_STATUS: Record<PlanStep["state"], string> = {
  running: "inProgress",
  done: "completed",
  error: "canceled",
};

/**
 * Send a `plan` row: the session's plan checklist, and an `action` for each
 * step that finished since the last plan sent.
 * @param row - The row.
 * @param inst - The installation.
 * @param sessionId - The session.
 */
async function sendPlan(
  row: OutboxMessage,
  inst: OpenInstallation,
  sessionId: string,
): Promise<void> {
  const steps = ((row.payload as { steps?: PlanStep[] }).steps ??
    []) as PlanStep[];
  await linearCall(inst, SESSION_UPDATE, {
    id: sessionId,
    input: {
      plan: steps.map((s) => ({
        content: `Run ${s.tool}`,
        status: PLAN_STATUS[s.state] ?? "pending",
      })),
    },
  });
  const before = new Map(
    (await previousPlan(row)).map((s) => [s.seq, s.state]),
  );
  for (const s of steps) {
    if (s.state === "running" || before.get(s.seq) === s.state) continue;
    await createActivity(
      inst,
      stableUuid(`outbox:${row.conversationId}:action:${s.seq}`),
      sessionId,
      {
        type: "action",
        action: s.state === "done" ? "Ran" : "Failed",
        parameter: s.tool,
        result: s.state === "done" ? "done" : "failed",
      },
    );
  }
}

/**
 * An approval's elicitation body.
 * @param p - The approval row's payload.
 * @returns The markdown.
 */
function approvalBody(p: Record<string, unknown>): string {
  const args = JSON.stringify(p.args ?? {}, null, 2);
  const how = p.inChannel
    ? `Choose **Approve #${p.approvalId}** or **Deny #${p.approvalId}**, or decide in the dashboard: ${approvalLink(Number(p.approvalId))}`
    : `A project member decides in the dashboard: ${approvalLink(Number(p.approvalId))}`;
  return `I need approval to run \`${String(p.name)}\` with:\n\n\`\`\`json\n${args.slice(0, 4000)}\n\`\`\`\n\n${how}`;
}

export const linearAdapter: PlatformAdapter = {
  type: "linear",
  label: "Linear",
  installationSchema,
  credentialSchema,
  capabilities: {
    threads: true,
    streaming: false,
    status: true,
    plan: true,
    buttons: true,
    ephemeral: false,
    edits: false,
    elicitation: true,
    typing: false,
  },
  settlesAtEnqueue: false,
  acknowledgeWhileInactive: true,
  globalConversationKeys: true,

  manifest(bot, urls) {
    const manifest = buildLinearManifest(bot, urls);
    const problems = [
      clientNameProblem(bot.displayName),
      (() => {
        const why = webhookUrlProblem(urls.events);
        return why
          ? `Linear will refuse the webhook URL because ${why}: set APPLICATION_URL to the deployment's public HTTPS origin first`
          : null;
      })(),
    ].filter(Boolean);
    return {
      instructions: `A Linear workspace admin opens the creation link (or Linear → Settings → API → New application, pasting this manifest) and creates ${bot.displayName}'s app; on the app's page, also turn on the "OAuthApp" (revocation) webhook. Then connect the app's Client ID, Client Secret, and webhook signing secret here, and install it into the workspace.${problems.length ? ` Before you do: ${problems.join("; ")}.` : ""}`,
      manifest,
      link: linearAppCreationLink(manifest),
    };
  },

  readyToActivate: (credentials) =>
    typeof credentials.accessToken === "string" &&
    credentials.accessToken !== "",

  verifyInbound(req: RawInbound, inst) {
    const signature = (req.headers.get("linear-signature") ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(signature)) {
      return { ok: false, reason: "unsigned" };
    }
    const secrets = [
      inst.credentials.webhookSecret,
      inst.credentials.webhookSecretPrevious,
    ].filter((s): s is string => typeof s === "string" && s !== "");
    if (
      !secrets.some((secret) =>
        safeEqual(linearSignature(secret, req.bytes), signature),
      )
    ) {
      return { ok: false, reason: "bad signature" };
    }
    // Only the body is signed, so the timestamp is read from it.
    let ts: number;
    try {
      ts = Number(
        (JSON.parse(req.text) as { webhookTimestamp?: unknown })
          .webhookTimestamp,
      );
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (
      !Number.isFinite(ts) ||
      Math.abs(Date.now() - ts) >
        config.platforms.linear.timestampToleranceSeconds * 1000
    ) {
      return { ok: false, reason: "stale" };
    }
    return { ok: true };
  },

  eventId: (body, req) => linearEventId(body, req.headers),

  workspaceOf(body) {
    const org = (body as { organizationId?: unknown })?.organizationId;
    return typeof org === "string" && org ? org : null;
  },

  parseInbound: (body, inst) => parseLinearDelivery(body, inst),

  resolveChannel: (inbound) => inbound.channel,

  async probe(inst) {
    if (typeof inst.credentials.accessToken !== "string") {
      throw new Error(
        "It is not installed in a workspace yet: install it (bot-installation:oauth-start).",
      );
    }
    try {
      const { viewer } = await linearCall<{ viewer: { id: string } }>(
        inst,
        VIEWER,
      );
      return { externalBotUserId: viewer.id };
    } catch (e) {
      if (e instanceof LinearApiError) {
        throw new Error(`Linear refused the app's token: ${e.detail}.`);
      }
      throw e;
    }
  },

  oauth: {
    pkce: true,
    tokenKeys: ["accessToken", "refreshToken"],

    authorizeUrl(inst, redirectUri, state, codeChallenge) {
      const url = new URL(config.platforms.linear.authorizeUrl);
      url.searchParams.set(
        "client_id",
        String(inst.installation.config.clientId ?? ""),
      );
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", LINEAR_SCOPES.join(","));
      url.searchParams.set("actor", "app");
      url.searchParams.set("state", state);
      if (codeChallenge) {
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url.toString();
    },

    async exchange(inst, code, redirectUri, codeVerifier) {
      const grant = await linearTokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: String(inst.installation.config.clientId ?? ""),
        client_secret: String(inst.credentials.clientSecret ?? ""),
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      });
      // Confirm the token works, and learn who the app is and where.
      const who = await linearGraphql<{
        viewer: { id: string; name: string; displayName?: string };
        organization: { id: string; name: string; urlKey: string };
      }>(grant.accessToken, VIEWER);
      return {
        credentials: {
          accessToken: grant.accessToken,
          ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
        },
        config: {
          appUserName: who.viewer.displayName ?? who.viewer.name,
          organizationName: who.organization.name,
          urlKey: who.organization.urlKey,
          scopes: grant.scopes.length > 0 ? grant.scopes : [...LINEAR_SCOPES],
          accessTokenExpiresAt: grant.expiresAt,
        },
        externalWorkspaceId: who.organization.id,
        externalBotUserId: who.viewer.id,
        externalAppId: String(inst.installation.config.clientId ?? "") || null,
      };
    },
  },

  target(channel: Channel, conversationKey: string | null) {
    return {
      type: "platform",
      platform: "linear",
      channelExternalId: channel.externalId.split("/").slice(1).join("/"),
      conversationKey,
    };
  },

  validateOutbound(draft) {
    if (draft.kind === "message" || draft.kind === "question") {
      if (typeof draft.payload.text !== "string" || !draft.payload.text) {
        return { refused: true, reason: `A ${draft.kind} needs text.` };
      }
    }
    if (draft.kind === "approval" && !draft.payload.approvalId) {
      return { refused: true, reason: "An approval needs its approvalId." };
    }
    if (draft.kind === "status" && typeof draft.payload.text !== "string") {
      return { refused: true, reason: "A status needs text." };
    }
    return applyFallbacks(draft, this.capabilities);
  },

  async send(row, ctx: SurfaceContext): Promise<SendResult> {
    const { installation } = ctx;
    if (!installation || installation.status !== "active") {
      return {
        outcome: "undeliverable",
        error: "The installation is not active.",
      };
    }
    const { openInstallation } = await import("../../ops/InstallationOps");
    const inst = openInstallation(installation);
    const t = row.target as { conversationKey?: string | null };
    const sessionId =
      t.conversationKey ?? ctx.conversation.externalConversationKey;
    if (!sessionId) {
      return { outcome: "undeliverable", error: "No agent session." };
    }
    const p = row.payload as Record<string, unknown>;
    const names = selfNames(inst);
    const body = (text: unknown) =>
      bodyForLinear(
        String(text ?? ""),
        names,
        transcriptLink(row.conversationId),
      );
    const id = stableUuid(`outbox:${row.id}`);
    const reserved = row.priority === "ack";
    // `attempts` counts this one: above one, an earlier attempt may have landed.
    const retry = row.attempts > 1;
    try {
      switch (row.kind) {
        case "status": {
          await createActivity(
            inst,
            id,
            sessionId,
            { type: "thought", body: body(p.text) },
            reserved ? {} : { ephemeral: true },
            reserved,
            retry,
          );
          const hygiene = p.hygiene as { issueId?: string } | undefined;
          if (reserved && hygiene?.issueId) {
            await issueHygiene(inst, hygiene.issueId);
          }
          return { outcome: "sent", externalMessageId: id };
        }
        case "plan":
          await sendPlan(row, inst, sessionId);
          return { outcome: "sent" };
        case "question": {
          const options = ((p.options as string[] | undefined) ?? []).filter(
            Boolean,
          );
          await createActivity(
            inst,
            id,
            sessionId,
            { type: "elicitation", body: body(p.text) },
            options.length > 0
              ? {
                  signal: "select",
                  signalMetadata: {
                    options: options.map((value) => ({ value })),
                  },
                }
              : {},
            false,
            retry,
          );
          return { outcome: "sent", externalMessageId: id };
        }
        case "approval": {
          const approvalId = Number(p.approvalId);
          await createActivity(
            inst,
            id,
            sessionId,
            { type: "elicitation", body: body(approvalBody(p)) },
            p.inChannel
              ? {
                  signal: "select",
                  signalMetadata: {
                    options: [
                      { value: `Approve #${approvalId}` },
                      { value: `Deny #${approvalId}` },
                    ],
                  },
                }
              : {},
            false,
            retry,
          );
          return { outcome: "sent", externalMessageId: id };
        }
        case "stream":
          return { outcome: "sent" };
        default: {
          const failed = p.messageKind === "error" || p.messageKind === "fail";
          await createActivity(
            inst,
            id,
            sessionId,
            { type: failed ? "error" : "response", body: body(p.text) },
            {},
            reserved,
            retry,
          );
          return { outcome: "sent", externalMessageId: id };
        }
      }
    } catch (e) {
      if (e instanceof LinearApiError) {
        if (e.retryable) {
          return {
            outcome: "retry",
            error: e.message,
            ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}),
          };
        }
        return { outcome: "undeliverable", error: e.message };
      }
      return {
        outcome: "retry",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
};
