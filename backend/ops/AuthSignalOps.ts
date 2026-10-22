import { isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import { config } from "keryx";
import { agentSessions } from "../schema/agent_sessions";
import { externalIdentities } from "../schema/external_identities";
import { runners } from "../schema/runners";
import type { WorkItem } from "../schema/work_items";
import type { TxHandle } from "./ProjectOps";

/**
 * The `auth` signal: an agent that cannot work until someone logs in says so
 * in Linear with an `elicitation` whose link leads the person who can fix it
 * to the fix.
 *
 * The daemon decides *what* needs a login (an agent, GitHub, a git host);
 * the server decides *where the link goes* and *who sees it*, because only
 * the server knows the dashboard's address and the Linear identities:
 *
 * | The daemon sent | `url` becomes |
 * |---|---|
 * | a `url` that is public `https` (an agent's own URL login) | that URL, unchanged |
 * | a `provider`, and no usable `url` | the runner's auth page, `<FRONTEND_URL>/runners/<id>/auth/<provider>`, which tells its owner the command to run on that machine |
 *
 * `userId` (Linear shows the link only to that user) is the runner owner's
 * linked Linear identity, else the session's creator — whatever the daemon
 * sent. `providerName` passes through.
 */

/** The provider a link falls back to when the daemon named none. */
const FALLBACK_PROVIDER = "agent";

/**
 * Whether a URL may be handed to a person as a login link: `https`, and a
 * host that is a public name — not an IP literal in a private, loopback, or
 * link-local range, not `localhost`, not a `.local` / `.internal` name.
 * Nothing fetches it; this keeps a daemon from pointing a person in Linear at
 * an address on its own network.
 * @param raw - The URL.
 * @returns True when public.
 */
export function isPublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (!host.includes(".") && isIP(host) === 0)
  ) {
    return false;
  }
  const family = isIP(host);
  if (family === 4) return !isPrivateV4(host);
  if (family === 6) return !isPrivateV6(host);
  return true;
}

/**
 * Whether an IPv4 address is private, loopback, link-local, CGNAT, or
 * unspecified.
 * @param host - Dotted quad.
 * @returns True when not public.
 */
function isPrivateV4(host: string): boolean {
  const [a, b] = host.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * Whether an IPv6 address is loopback, unspecified, unique-local,
 * link-local, or an IPv4-mapped private address.
 * @param host - The address, without brackets.
 * @returns True when not public.
 */
function isPrivateV6(host: string): boolean {
  if (host === "::1" || host === "::") return true;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  // `URL` writes a mapped address in hex: `::ffff:a00:1` is 10.0.0.1.
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(host);
}

/**
 * The runner auth page for a provider.
 * @param runnerId - The runner.
 * @param provider - The provider's slug.
 * @returns The absolute dashboard URL.
 */
export function runnerAuthUrl(runnerId: number, provider: string): string {
  const base = String(config.notifications.appUrl).replace(/\/+$/, "");
  return `${base}/runners/${runnerId}/auth/${encodeURIComponent(provider)}`;
}

/**
 * The Linear user who should see an auth link for a turn: the runner owner's
 * linked identity in this session's workspace, else the session's creator.
 * @param tx - The transaction.
 * @param item - The held work item.
 * @returns The Linear user id, or null when neither is known.
 */
async function authAudience(
  tx: TxHandle,
  item: WorkItem,
): Promise<string | null> {
  const [row] = await tx
    .select({
      integrationId: agentSessions.integrationId,
      creator: agentSessions.creatorExternalUserId,
      ownerId: runners.userId,
    })
    .from(agentSessions)
    .leftJoin(runners, eq(runners.id, item.runnerId ?? -1))
    .where(eq(agentSessions.id, item.agentSessionId));
  if (!row) return null;
  if (row.ownerId !== null) {
    const [identity] = await tx
      .select({ externalUserId: externalIdentities.externalUserId })
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.integrationId, row.integrationId),
          eq(externalIdentities.userId, row.ownerId),
        ),
      )
      .limit(1);
    if (identity) return identity.externalUserId;
  }
  return row.creator;
}

/**
 * The `signalMetadata` an `auth` elicitation is sent to Linear with, from
 * what the daemon reported (see the table above).
 * @param tx - The transaction.
 * @param item - The held work item that asked.
 * @param reported - The daemon's metadata, schema-valid.
 * @returns Linear's metadata: `url`, and `userId` / `providerName` when known.
 */
export async function resolveAuthMetadata(
  tx: TxHandle,
  item: WorkItem,
  reported: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url =
    typeof reported.url === "string" && isPublicUrl(reported.url)
      ? reported.url
      : runnerAuthUrl(
          item.runnerId ?? 0,
          typeof reported.provider === "string"
            ? reported.provider
            : FALLBACK_PROVIDER,
        );
  const userId = await authAudience(tx, item);
  return {
    url,
    ...(userId ? { userId } : {}),
    ...(typeof reported.providerName === "string"
      ? { providerName: reported.providerName }
      : {}),
  };
}
