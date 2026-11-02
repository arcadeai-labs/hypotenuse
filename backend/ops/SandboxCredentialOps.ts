import { and, eq } from "drizzle-orm";
import { api, ErrorType, TypedError } from "keryx";
import { z } from "zod";
import {
  CONNECTION_DEFINITIONS,
  CONNECTION_KINDS,
  type ConnectionDefinition,
} from "../connections/registry";
import {
  assertSandboxProviderAllowed,
  SANDBOX_PROVIDERS,
} from "../sandbox/registry";
import type {
  ProviderConnection,
  SandboxProvider,
  SandboxProviderName,
} from "../sandbox/types";
import {
  type ProjectConnection,
  projectConnections,
} from "../schema/project_connections";
import { decryptSecret } from "./CryptoOps";
import type { DbHandle } from "./DbOps";

/**
 * **A project's sandbox accounts.** A hosted provider runs on the project's
 * own account, held in `project_connections`: this module finds the row,
 * decrypts its secret for the call that needs it, and builds the provider —
 * so the registry stays free of rows and the actions free of crypto.
 */

/** The `kind` input every connection action takes. */
export const connectionKindInput = z
  .string()
  .trim()
  .refine((v) => CONNECTION_KINDS.includes(v), {
    message: `one of: ${CONNECTION_KINDS.join(", ")}`,
  })
  .describe(`The kind of account: ${CONNECTION_KINDS.join(", ")}`);

/**
 * A connection kind's definition, refusing an unknown one.
 * @param kind - The kind.
 * @returns Its definition.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`.
 */
export function connectionDefinition(kind: string): ConnectionDefinition {
  const definition = CONNECTION_DEFINITIONS[kind];
  if (!definition) {
    throw new TypedError({
      message: `"${kind}" is not a connection kind. Choose one of: ${CONNECTION_KINDS.join(", ")}.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "kind",
    });
  }
  return definition;
}

/**
 * Check a connection's non-secret fields against its definition: every
 * field present, each matching its pattern, nothing extra.
 * @param definition - The kind.
 * @param config - The fields.
 * @returns The fields, trimmed.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`, naming the field.
 */
export function validateConnectionConfig(
  definition: ConnectionDefinition,
  config: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of definition.fields) {
    const raw = config[field.key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      throw new TypedError({
        message: `A ${definition.label} connection needs ${field.label.toLowerCase()} (${field.key}): ${field.description}`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: field.key,
      });
    }
    if (field.pattern && !field.pattern.regex.test(value)) {
      throw new TypedError({
        message: `${field.key} should be ${field.pattern.hint}.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: field.key,
      });
    }
    out[field.key] = value;
  }
  return out;
}

/**
 * A project's connection of one kind.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param kind - The kind.
 * @returns The row, or `undefined`.
 */
export async function loadProjectConnection(
  db: DbHandle,
  projectId: number,
  kind: string,
): Promise<ProjectConnection | undefined> {
  const [row] = await db
    .select()
    .from(projectConnections)
    .where(
      and(
        eq(projectConnections.projectId, projectId),
        eq(projectConnections.kind, kind),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Decrypt a connection for the call that uses it.
 * @param row - The row.
 * @returns Its fields and its secret, in plaintext.
 */
export function openConnection(row: ProjectConnection): ProviderConnection {
  return { config: { ...row.config }, secret: decryptSecret(row.secret) };
}

/**
 * Run a kind's probe, answering how it went rather than throwing.
 * @param kind - The kind.
 * @param connection - The decrypted connection.
 * @returns `ok` and what it found, or `error` and why.
 */
export async function probeConnection(
  kind: string,
  connection: ProviderConnection,
): Promise<{ status: "ok" | "error"; message: string }> {
  try {
    const message = await connectionDefinition(kind).probe(connection);
    return { status: "ok", message };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: "error",
      message:
        connection.secret.length >= 4
          ? message.split(connection.secret).join("[redacted]")
          : message,
    };
  }
}

/**
 * Build the provider a project's sandboxes run on — with the project's
 * decrypted connection, for a provider that needs one. **The** way to a
 * provider instance: provisioning, destroying a ledgered sandbox, and the
 * ledger's own actions all come here.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param kind - The provider.
 * @returns The provider.
 * @throws {TypedError} When the provider is refused here, or the project has
 *   no connection for it.
 */
export async function providerForProject(
  db: DbHandle,
  projectId: number,
  kind: string,
): Promise<SandboxProvider> {
  const definition = assertSandboxProviderAllowed(kind);
  if (!definition.connectionKind) return definition.build(null);
  const row = await loadProjectConnection(
    db,
    projectId,
    definition.connectionKind,
  );
  if (!row) {
    throw new TypedError({
      message: `This project runs sandboxes on ${definition.label} and has no ${definition.connectionKind} connection. A project admin adds one under Settings → Sandboxes.`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
  return definition.build(openConnection(row));
}

/**
 * Every connection a provider kind's orphan sweep must look through, opened
 * — a provider on per-project accounts is swept one account at a time.
 * @param db - A database handle.
 * @param kind - The provider.
 * @returns Each connection's project and provider instance.
 */
export async function providersToSweep(
  db: DbHandle,
  kind: SandboxProviderName,
): Promise<{ projectId: number | null; provider: SandboxProvider }[]> {
  const definition = SANDBOX_PROVIDERS[kind];
  if (!definition.connectionKind) {
    return [{ projectId: null, provider: definition.build(null) }];
  }
  const rows = await db
    .select()
    .from(projectConnections)
    .where(eq(projectConnections.kind, definition.connectionKind));
  // One account that cannot be opened (a corrupt seal, a missing field)
  // must not leave every other project's orphans running: skip it, say so.
  const out: { projectId: number | null; provider: SandboxProvider }[] = [];
  for (const row of rows) {
    try {
      out.push({
        projectId: row.projectId,
        provider: definition.build(openConnection(row)),
      });
    } catch (e) {
      api.logger.warn("could not open a sandbox provider account to sweep", {
        provider: kind,
        projectId: row.projectId,
        connectionId: row.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

/**
 * Shape a connection for any answer. The secret has no field here; its last
 * four characters are all that is ever returned.
 * @param row - The row.
 * @returns The serialized connection.
 */
export function serializeProjectConnection(row: ProjectConnection) {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    name: row.name,
    config: { ...row.config },
    lastFour: row.lastFour,
    status: row.status,
    lastCheckedAt: row.lastCheckedAt?.getTime() ?? null,
    lastError: row.lastError,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * Load a project's connection by id, or refuse with a 404.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param connectionId - The connection.
 * @param options - Locking.
 * @param options.lock - Take `FOR UPDATE`.
 * @returns The row.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadProjectConnectionById(
  db: DbHandle,
  projectId: number,
  connectionId: number,
  options: { lock?: boolean } = {},
): Promise<ProjectConnection> {
  const query = db
    .select()
    .from(projectConnections)
    .where(
      and(
        eq(projectConnections.id, connectionId),
        eq(projectConnections.projectId, projectId),
      ),
    )
    .limit(1);
  const [row] = options.lock ? await query.for("update") : await query;
  if (!row) {
    throw new TypedError({
      message: "Connection not found in this project",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return row;
}

/** The `config` input of `connection:create` and `connection:edit`. */
export const connectionConfigInput = z
  .record(z.string(), z.string().trim().max(200))
  .describe(
    "The connection's non-secret fields, by key — for vercel, { teamId: 'team_…', projectId: 'prj_…' }",
  );

/** The `secret` input's shape, before `secret()` marks it for redaction. */
export const connectionSecretShape = z
  .string()
  .trim()
  .min(1, "A secret is required")
  .max(4096);
