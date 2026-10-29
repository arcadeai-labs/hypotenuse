import type { LanguageModelV4 } from "@ai-sdk/provider";
import { and, asc, eq, inArray } from "drizzle-orm";
import { api, ErrorType, TypedError } from "keryx";
import { z } from "zod";
import {
  type ListedModel,
  MODEL_PROVIDERS,
  type ProviderCredentials,
  providerKind,
} from "../models/registry";
import { bots } from "../schema/bots";
import {
  type ModelAlias,
  type ModelAliasOptions,
  modelAliases,
} from "../schema/model_aliases";
import {
  type ModelConnection,
  modelConnections,
} from "../schema/model_connections";
import { decryptSecret } from "./CryptoOps";
import type { DbHandle } from "./DbOps";
import { urlRefusal } from "./NetworkGuardOps";

/**
 * Model connections and the named model registry: the only way any code
 * obtains a model, and the serializers that keep a key out of every answer.
 */

/**
 * The alias names every project must define before a bot of it can run:
 * `default` does the thinking, `fast` the cheap auxiliary calls (titles,
 * summaries, guards). Reserved: they cannot be renamed away, and a bot that
 * names neither still names these by default.
 */
export const RESERVED_MODEL_ALIASES = ["default", "fast"] as const;

/**
 * Whether an alias name is one of {@link RESERVED_MODEL_ALIASES}.
 * @param name - The alias name.
 * @returns `true` if reserved.
 */
export function isReservedModelAlias(name: string): boolean {
  return (RESERVED_MODEL_ALIASES as readonly string[]).includes(name);
}

/**
 * The Zod input for an alias name: lowercase letters, digits, and dashes.
 * @param description - What the name is for.
 * @returns The schema.
 */
export function aliasNameInput(description: string) {
  return z
    .string()
    .trim()
    .min(1, "An alias name is required")
    .max(64, "An alias name is at most 64 characters")
    .regex(
      /^[a-z0-9-]+$/,
      "An alias name uses lowercase letters, digits, and dashes",
    )
    .describe(description);
}

/** The Zod input for a provider kind. */
export const providerInput = z
  .enum(MODEL_PROVIDERS)
  .describe(
    "The provider kind: anthropic, openai, gateway (Vercel AI Gateway), or openai-compatible (needs baseUrl)",
  );

/** The Zod input for a connection's name. */
export const connectionNameInput = z
  .string()
  .trim()
  .min(1, "A connection name is required")
  .max(80, "A connection name is at most 80 characters")
  .describe("A name for this connection, unique in the project");

/** The Zod input for a base URL: an absolute URL, at most 2048 characters. */
export const baseUrlInput = z
  .string()
  .trim()
  .max(2048)
  .url("The base URL must be an absolute URL")
  .describe(
    "The provider's base URL, as the AI SDK takes it (e.g. https://api.openai.com/v1). Required for openai-compatible; omit for the provider's default",
  );

/** The Zod input for a provider's model id. */
export const modelIdInput = z
  .string()
  .trim()
  .min(1, "A model id is required")
  .max(256)
  .describe(
    "The provider's model id, e.g. claude-sonnet-4-5 or gpt-5; model-connection:models lists them",
  );

/** The Zod input for an alias's call options. */
export const aliasOptionsInput = z
  .object({
    maxOutputTokens: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .optional()
      .describe("The most tokens one call may produce"),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe("Sampling temperature, 0 to 2"),
    providerOptions: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Provider-specific options keyed by provider, e.g. {"anthropic": {"thinking": {"type": "enabled", "budgetTokens": 4000}}}',
      ),
  })
  .strict()
  .describe("Options applied to every call made through this alias");

/**
 * Shape a connection for any answer. There is deliberately no field a key fits
 * in: `lastFour` is the only part of it that leaves the server.
 * @param row - The connection row.
 * @returns The serialized connection.
 */
export function serializeModelConnection(row: ModelConnection) {
  const kind = safeKind(row.provider);
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    provider: row.provider,
    providerLabel: kind?.label ?? row.provider,
    baseUrl: row.baseUrl,
    defaultBaseUrl: kind?.defaultBaseUrl ?? null,
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
 * Shape an alias for any answer.
 * @param row - The alias row.
 * @param connection - Its connection, when the caller loaded it, for the name.
 * @returns The serialized alias.
 */
export function serializeModelAlias(
  row: ModelAlias,
  connection?: Pick<ModelConnection, "name" | "provider"> | null,
) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    kind: row.kind,
    reserved: isReservedModelAlias(row.name),
    connectionId: row.connectionId,
    connectionName: connection?.name ?? null,
    provider: connection?.provider ?? null,
    modelId: row.modelId,
    options: row.options as ModelAliasOptions,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * The registry entry for a provider name, or `null` for an unknown one.
 * @param provider - The stored provider name.
 * @returns The kind, or `null`.
 */
function safeKind(provider: string) {
  try {
    return providerKind(provider);
  } catch {
    return null;
  }
}

/**
 * Refuse a base URL a connection of this kind cannot use: missing where the
 * kind requires one, or one the SSRF guard refuses.
 * @param provider - The provider kind.
 * @param baseUrl - The base URL, or `null` for the kind's default.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` keyed on `baseUrl`.
 */
export async function assertUsableBaseUrl(
  provider: string,
  baseUrl: string | null,
): Promise<void> {
  const kind = providerKind(provider);
  if (!baseUrl) {
    if (kind.defaultBaseUrl) return;
    throw new TypedError({
      message: `A ${kind.label} connection needs a base URL, such as https://example.com/v1.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "baseUrl",
    });
  }
  const refusal = await urlRefusal(baseUrl);
  if (refusal) {
    throw new TypedError({
      message: refusal,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "baseUrl",
    });
  }
}

/**
 * A connection's credentials, decrypted. Call it at the use, and let the
 * result go out of scope with the call.
 * @param row - The connection row.
 * @returns The base URL and plaintext key.
 */
function credentialsOf(row: ModelConnection): ProviderCredentials {
  return { baseUrl: row.baseUrl, apiKey: decryptSecret(row.secret) };
}

/** What a probe found, ready to write onto the connection row. */
export interface ProbeResult {
  status: "ok" | "error";
  lastError: string | null;
  lastCheckedAt: Date;
}

/**
 * Prove a connection's key works against its endpoint. Never throws: a failed
 * probe is a status, recorded on the row, with the sentence that explains it.
 * @param row - The connection row (or one about to be written).
 * @returns The status to record.
 */
export async function probeConnection(
  row: ModelConnection,
): Promise<ProbeResult> {
  const credentials = credentialsOf(row);
  try {
    await providerKind(row.provider).probe(credentials);
    return { status: "ok", lastError: null, lastCheckedAt: new Date() };
  } catch (error) {
    return {
      status: "error",
      lastError: probeMessage(error, credentials.apiKey),
      lastCheckedAt: new Date(),
    };
  }
}

/**
 * The models a connection's endpoint reports, live. Nothing is stored.
 * @param row - The connection row.
 * @returns The models, sorted by id.
 * @throws {TypedError} `CONNECTION_ACTION_RUN` naming why the endpoint did not list.
 */
export async function listConnectionModels(
  row: ModelConnection,
): Promise<ListedModel[]> {
  const credentials = credentialsOf(row);
  try {
    const models = await providerKind(row.provider).listModels(credentials);
    return models.sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    throw new TypedError({
      message: `Could not list this connection's models: ${probeMessage(error, credentials.apiKey)} Type the model id instead.`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
}

/**
 * A probe failure as one sentence, at most 500 characters, never carrying
 * the key: a provider's error body is quoted into the message, and one that
 * echoes the request would otherwise put the key in a row every member reads.
 * @param error - What the probe threw.
 * @param apiKey - The key, to redact wherever it appears.
 * @returns The sentence.
 */
function probeMessage(error: unknown, apiKey: string): string {
  const raw =
    error instanceof Error && error.message
      ? error.message
      : "The provider could not be reached.";
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? ` (${error.cause.message})`
      : "";
  return `${raw}${cause}`.split(apiKey).join("[redacted]").slice(0, 500);
}

/**
 * Load a connection of a project, or refuse with the same 404 for a missing
 * one and one of another project.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param connectionId - The connection.
 * @param options.lock - Take `FOR UPDATE` (inside a writing transaction).
 * @returns The row.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadModelConnection(
  db: DbHandle,
  projectId: number,
  connectionId: number,
  options: { lock?: boolean } = {},
): Promise<ModelConnection> {
  const query = db
    .select()
    .from(modelConnections)
    .where(
      and(
        eq(modelConnections.id, connectionId),
        eq(modelConnections.projectId, projectId),
      ),
    )
    .limit(1);
  const [row] = options.lock ? await query.for("update") : await query;
  if (!row) {
    throw new TypedError({
      message: "Model connection not found in this project",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return row;
}

/**
 * Load an alias of a project by id, or refuse with a 404.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param aliasId - The alias.
 * @param options.lock - Take `FOR UPDATE`.
 * @returns The row.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadModelAlias(
  db: DbHandle,
  projectId: number,
  aliasId: number,
  options: { lock?: boolean } = {},
): Promise<ModelAlias> {
  const query = db
    .select()
    .from(modelAliases)
    .where(
      and(eq(modelAliases.id, aliasId), eq(modelAliases.projectId, projectId)),
    )
    .limit(1);
  const [row] = options.lock ? await query.for("update") : await query;
  if (!row) {
    throw new TypedError({
      message: "Model alias not found in this project",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return row;
}

/**
 * The names of a project's aliases, for checking the ones a bot names.
 * @param db - A database handle.
 * @param projectId - The project.
 * @returns Every alias name.
 */
export async function aliasNames(
  db: DbHandle,
  projectId: number,
): Promise<Set<string>> {
  const rows = await db
    .select({ name: modelAliases.name })
    .from(modelAliases)
    .where(eq(modelAliases.projectId, projectId));
  return new Set(rows.map((r) => r.name));
}

/**
 * The reserved aliases a project has not defined yet. While any is missing,
 * no bot of the project can run.
 * @param db - A database handle.
 * @param projectId - The project.
 * @returns The missing names, in reserved order.
 */
export async function missingRequiredAliases(
  db: DbHandle,
  projectId: number,
): Promise<string[]> {
  const defined = await aliasNames(db, projectId);
  return RESERVED_MODEL_ALIASES.filter((name) => !defined.has(name));
}

/**
 * The bots of a project that name an alias, as either model.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param aliasName - The alias name.
 * @returns Each bot's id and name, by name.
 */
export async function botsNamingAlias(
  db: DbHandle,
  projectId: number,
  aliasName: string,
): Promise<{ id: number; name: string }[]> {
  const rows = await db
    .select({
      id: bots.id,
      name: bots.name,
      modelAlias: bots.modelAlias,
      fastModelAlias: bots.fastModelAlias,
    })
    .from(bots)
    .where(eq(bots.projectId, projectId))
    .orderBy(asc(bots.name));
  return rows
    .filter((b) => b.modelAlias === aliasName || b.fastModelAlias === aliasName)
    .map(({ id, name }) => ({ id, name }));
}

/**
 * Connections by id, for naming each alias's connection in a list.
 * @param db - A database handle.
 * @param ids - The connection ids.
 * @returns Each connection's name and provider, by id.
 */
export async function connectionsById(
  db: DbHandle,
  ids: number[],
): Promise<Map<number, Pick<ModelConnection, "name" | "provider">>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: modelConnections.id,
      name: modelConnections.name,
      provider: modelConnections.provider,
    })
    .from(modelConnections)
    .where(inArray(modelConnections.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/** A language model, ready for `generateText` / `streamText`, and its alias's options. */
export interface ResolvedLanguageModel {
  model: LanguageModelV4;
  options: ModelAliasOptions;
  alias: string;
}

/**
 * **The** way any code obtains a language model: alias → connection →
 * provider, with the key decrypted here, in the process making the call.
 * @param projectId - The project.
 * @param alias - The alias name, e.g. a bot's `modelAlias`.
 * @returns The model and the alias's call options.
 * @throws {TypedError} `CONNECTION_ACTION_RUN` naming what an admin must set up.
 */
export async function languageModel(
  projectId: number,
  alias: string,
): Promise<ResolvedLanguageModel> {
  const [row] = await api.db.db
    .select({ alias: modelAliases, connection: modelConnections })
    .from(modelAliases)
    .innerJoin(
      modelConnections,
      eq(modelConnections.id, modelAliases.connectionId),
    )
    .where(
      and(
        eq(modelAliases.projectId, projectId),
        eq(modelAliases.name, alias),
        eq(modelAliases.kind, "language"),
      ),
    )
    .limit(1);
  if (!row) {
    throw new TypedError({
      message: `This project has no model named "${alias}". A project admin adds it under Settings → Models.`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
  const provider = providerKind(row.connection.provider).build(
    credentialsOf(row.connection),
  );
  return {
    model: provider.languageModel(row.alias.modelId),
    options: row.alias.options as ModelAliasOptions,
    alias,
  };
}

/**
 * The way code will obtain an embedding model. No alias kind names one yet,
 * so it always refuses.
 * @param _projectId - The project.
 * @param alias - The alias name.
 * @returns Never.
 * @throws {TypedError} `CONNECTION_ACTION_RUN`.
 */
export async function embeddingModel(
  _projectId: number,
  alias: string,
): Promise<never> {
  throw new TypedError({
    message: `Embedding models are not supported yet, so "${alias}" cannot be used for embeddings.`,
    type: ErrorType.CONNECTION_ACTION_RUN,
  });
}
