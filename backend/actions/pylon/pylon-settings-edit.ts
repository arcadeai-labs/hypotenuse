import { and, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { serializeInstallation } from "../../ops/InstallationOps";
import {
  CUSTOMER_REPLY_POLICIES,
  pylonInstallationSchema,
} from "../../platforms/pylon/adapter";
import { botInstallations } from "../../schema/bot_installations";

/**
 * `pylon:settings-edit` — a project admin decides how a bot works a Pylon
 * queue: its **customer reply policy** (`never`, the default; `approve`;
 * `auto-on-low-risk`), its triggers, the teams and tags it listens to, the
 * name teammates mention it by, and whether the legacy signature is accepted.
 * The policy is set nowhere else (`bot-installation:connect` refuses it), and
 * who set it is recorded with it: an auto-sent reply is audited as that
 * admin's decision. Admin-only and audited.
 */
export class PylonSettingsEdit extends AuditedAction {
  name = "pylon:settings-edit";
  description =
    "Change how a bot works a Pylon queue: customerReplyPolicy (never — the bot only writes internal notes; approve — it may draft a reply to the customer that waits for a person's approval; auto-on-low-risk — it sends a reply its fast model rates low-risk, and asks for approval otherwise), triggers {autoTriage, mention, assignment}, listen {teamIds, tags}, selfName (its token's name in Pylon), and legacySignature. Only what you pass changes. Project admins only.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/pylon/settings",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    externalWorkspaceId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('The installation\'s workspace (default "default")'),
    customerReplyPolicy: z
      .enum(CUSTOMER_REPLY_POLICIES)
      .optional()
      .describe("Whether, and how, the bot may reply to customers"),
    triggers: z
      .object({
        autoTriage: z.boolean().optional(),
        mention: z.boolean().optional(),
        assignment: z.boolean().optional(),
      })
      .optional()
      .describe("Which Pylon events start or continue work"),
    listen: z
      .object({
        teamIds: z.array(z.string().max(200)).max(50).optional(),
        tags: z.array(z.string().max(200)).max(50).optional(),
      })
      .optional()
      .describe(
        "The Pylon teams and tags new issues must be in (any when empty)",
      ),
    selfName: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        "The token identity's name, which teammates mention the bot by",
      ),
    legacySignature: z
      .boolean()
      .optional()
      .describe("Accept the legacy X-Pylon-Signature, which has no timestamp"),
  });

  /**
   * @param tx - The transaction the change and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The installation, without its credentials.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` with no Pylon installation.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<PylonSettingsEdit>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(tx, params.projectId, params.botId, tags);
    const workspace = params.externalWorkspaceId ?? "default";
    const [existing] = await tx
      .select()
      .from(botInstallations)
      .where(
        and(
          eq(botInstallations.botId, bot.id),
          eq(botInstallations.type, "pylon"),
          eq(botInstallations.externalWorkspaceId, workspace),
        ),
      )
      .for("update");
    if (!existing) {
      throw new TypedError({
        message: `"${bot.name}" has no Pylon installation yet. Get its manifest (bot-installation:manifest with type pylon) and connect its token first.`,
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    const current = existing.config as Record<string, unknown>;
    const currentTriggers = (current.triggers ?? {}) as Record<string, unknown>;
    const currentListen = (current.listen ?? {}) as Record<string, unknown>;
    const userId = connection.session?.data.userId ?? null;
    const next = pylonInstallationSchema.parse({
      ...current,
      ...(params.customerReplyPolicy !== undefined
        ? {
            customerReplyPolicy: params.customerReplyPolicy,
            customerReplyPolicySetByUserId: userId,
          }
        : {}),
      ...(params.triggers
        ? { triggers: { ...currentTriggers, ...params.triggers } }
        : {}),
      ...(params.listen
        ? { listen: { ...currentListen, ...params.listen } }
        : {}),
      ...(params.selfName !== undefined ? { selfName: params.selfName } : {}),
      ...(params.legacySignature !== undefined
        ? { legacySignature: params.legacySignature }
        : {}),
    });
    const [row] = await tx
      .update(botInstallations)
      .set({ config: next })
      .where(eq(botInstallations.id, existing.id))
      .returning();
    connection.metadata.auditBefore = serializeInstallation(existing);
    connection.metadata.auditAfter = serializeInstallation(row);
    connection.metadata.auditTargetType = "bot-installation";
    connection.metadata.auditTargetPath = `${bot.slug}/pylon/${row.externalWorkspaceId}`;
    return { installation: serializeInstallation(row) };
  }
}
