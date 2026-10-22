import { and, eq, sql } from "drizzle-orm";
import type { api } from "keryx";
import type { AgentSession } from "../schema/agent_sessions";
import {
  type ExternalIdentity,
  externalIdentities,
} from "../schema/external_identities";
import { projectMemberships } from "../schema/project_memberships";
import { users } from "../schema/users";
import type { TxHandle } from "./ProjectOps";

/**
 * Who started a session, as a Hypotenuse user — so routing can prefer the
 * issuer's own runners. A **preference, never an authorization**: it only
 * reorders runners that are already eligible in the same project, which is
 * why an unverified e-mail match is acceptable here and nowhere else.
 */

/** Every DB handle identities are read through. */
type Db = TxHandle | typeof api.db.db;

/**
 * The Hypotenuse user behind a session's creator.
 *
 * In order: an existing identity row for the creator in this integration;
 * else a member of the session's project whose e-mail equals the creator's
 * (case-insensitive), recorded as `linkedVia = email` so it is visible and
 * removable; else none. A session an automation or another agent started has
 * no creator, and so no issuer.
 * @param tx - The transaction (the e-mail link is written in it).
 * @param session - The session.
 * @returns The user id, or null.
 */
export async function resolveIssuer(
  tx: TxHandle,
  session: AgentSession,
): Promise<number | null> {
  const linked = await linkedIssuer(tx, session);
  if (linked !== null) return linked;
  if (!session.creatorExternalUserId) return null;

  const email = session.creatorEmail?.trim();
  if (!email) return null;
  const [member] = await tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(
      projectMemberships,
      and(
        eq(projectMemberships.userId, users.id),
        eq(projectMemberships.projectId, session.projectId),
      ),
    )
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  if (!member) return null;

  await tx
    .insert(externalIdentities)
    .values({
      type: session.type,
      integrationId: session.integrationId,
      userId: member.id,
      externalUserId: session.creatorExternalUserId,
      externalName: session.creatorName,
      externalEmail: email,
      linkedVia: "email",
    })
    .onConflictDoNothing();
  return member.id;
}

/**
 * The issuer's Hypotenuse user through an existing identity link only — a
 * member of the session's project linked to its creator. Reads, never
 * writes; {@link resolveIssuer} adds the e-mail match.
 * @param db - Where to read.
 * @param session - The session.
 * @returns The user id, or null.
 */
export async function linkedIssuer(
  db: Db,
  session: AgentSession,
): Promise<number | null> {
  if (!session.creatorExternalUserId) return null;
  const [linked] = await db
    .select({ userId: externalIdentities.userId })
    .from(externalIdentities)
    .innerJoin(
      projectMemberships,
      and(
        eq(projectMemberships.userId, externalIdentities.userId),
        eq(projectMemberships.projectId, session.projectId),
      ),
    )
    .where(
      and(
        eq(externalIdentities.integrationId, session.integrationId),
        eq(externalIdentities.externalUserId, session.creatorExternalUserId),
      ),
    )
    .limit(1);
  return linked?.userId ?? null;
}

/**
 * One identity of an integration, or nothing.
 * @param db - Where to read.
 * @param integrationId - The integration.
 * @param id - The identity's id.
 * @returns The row, or undefined.
 */
export async function identityInIntegration(
  db: Db,
  integrationId: number,
  id: number,
): Promise<ExternalIdentity | undefined> {
  const [row] = await db
    .select()
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.id, id),
        eq(externalIdentities.integrationId, integrationId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Shape an identity for the API.
 * @param row - The row.
 * @param user - The Hypotenuse user's name and e-mail, when known.
 * @returns The serialized identity, timestamps as epoch ms.
 */
export function serializeExternalIdentity(
  row: ExternalIdentity,
  user?: { name: string; email: string } | null,
) {
  return {
    id: row.id,
    type: row.type,
    integrationId: row.integrationId,
    userId: row.userId,
    user: user ?? null,
    externalUserId: row.externalUserId,
    externalName: row.externalName,
    externalEmail: row.externalEmail,
    linkedVia: row.linkedVia,
    createdAt: row.createdAt.getTime(),
  };
}

/** {@link serializeExternalIdentity}'s output. */
export type SerializedExternalIdentity = ReturnType<
  typeof serializeExternalIdentity
>;
