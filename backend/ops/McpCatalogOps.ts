import { createHash } from "node:crypto";
import { embedMany } from "ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/mcp";
import { type BotMcpServer, botMcpServers } from "../schema/bot_mcp_servers";
import {
  type McpCatalogTool,
  type McpServer,
  mcpServers,
} from "../schema/mcp_servers";
import { MEMORY_EMBEDDING_DIMENSIONS } from "../schema/memory_chunks";
import { allowance } from "./ApprovalPatternOps";
import type { DbHandle } from "./DbOps";
import { listServerTools, McpUnauthorized } from "./McpClientOps";
import { embeddingModel } from "./ModelOps";

/**
 * The tool catalog: each server's tools as `tools/list` last answered (cached
 * on its row), what a bot may see of them, and search over them — keyword
 * (`ts_rank_cd` over name and description) fused with semantic ranking from
 * the memory embedder by weighted reciprocal-rank fusion, as memory search
 * does. Tool embeddings are cached in Redis by embedding revision and text,
 * so a refresh re-embeds only what changed.
 */

/** A server a bot may use, with its binding. */
export interface BotServer {
  server: McpServer;
  binding: BotMcpServer;
}

/**
 * The enabled servers a bot is bound to, by name.
 * @param db - A database handle.
 * @param botId - The bot.
 * @returns The servers and bindings, sorted by server name.
 */
export async function botServers(
  db: DbHandle,
  botId: number,
): Promise<BotServer[]> {
  const rows = await db
    .select({ server: mcpServers, binding: botMcpServers })
    .from(botMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, botMcpServers.mcpServerId))
    .where(and(eq(botMcpServers.botId, botId), eq(mcpServers.enabled, true)))
    .orderBy(mcpServers.name);
  return rows;
}

/**
 * Whether a bot has any enabled MCP server.
 * @param db - A database handle.
 * @param botId - The bot.
 * @returns `true` if so.
 */
export async function botHasServers(
  db: DbHandle,
  botId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: botMcpServers.id })
    .from(botMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, botMcpServers.mcpServerId))
    .where(and(eq(botMcpServers.botId, botId), eq(mcpServers.enabled, true)))
    .limit(1);
  return Boolean(row);
}

/**
 * Find one of a bot's servers by name.
 * @param servers - The bot's servers.
 * @param name - The server's name.
 * @returns It, or `undefined`.
 */
export function findServer(
  servers: BotServer[],
  name: string,
): BotServer | undefined {
  return servers.find((s) => s.server.name === name);
}

/**
 * Find a tool in a server's cached catalog.
 * @param server - The server.
 * @param tool - The tool's name.
 * @returns It, or `undefined`.
 */
export function findTool(
  server: McpServer,
  tool: string,
): McpCatalogTool | undefined {
  return server.toolsCache.find((t) => t.name === tool);
}

/**
 * A digest of a catalog, so a refresh can tell whether anything changed.
 * @param tools - The catalog.
 * @returns The hex digest.
 */
export function catalogHash(tools: McpCatalogTool[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...tools]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t) => [t.name, t.description, t.inputSchema, t.annotations]),
      ),
    )
    .digest("hex");
}

/** What a refresh did. */
export interface RefreshResult {
  ok: boolean;
  changed: boolean;
  toolCount: number;
  error: string | null;
  server: McpServer;
}

/**
 * Connect, list the server's tools, and store the catalog and the status. A
 * failure is recorded on the row, never thrown. When the catalog changed, the
 * caller enqueues {@link enqueueCapabilitiesForServer} once the write commits.
 * @param server - The server.
 * @param db - Where to write (an audited action's transaction, or the pool).
 * @returns What happened.
 */
export async function refreshCatalog(
  server: McpServer,
  db: DbHandle = api.db.db,
): Promise<RefreshResult> {
  try {
    const tools = await listServerTools(server);
    const changed = catalogHash(tools) !== catalogHash(server.toolsCache);
    const [row] = await db
      .update(mcpServers)
      .set({
        toolsCache: tools,
        toolsRefreshedAt: new Date(),
        status: "ok",
        lastError: null,
      })
      .where(eq(mcpServers.id, server.id))
      .returning();
    return {
      ok: true,
      changed,
      toolCount: tools.length,
      error: null,
      server: row ?? server,
    };
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 1000);
    const [row] = await db
      .update(mcpServers)
      .set({
        status:
          error instanceof McpUnauthorized && server.authMode === "oauth"
            ? "needs_auth"
            : "error",
        lastError: message,
      })
      .where(eq(mcpServers.id, server.id))
      .returning();
    return {
      ok: false,
      changed: false,
      toolCount: server.toolsCache.length,
      error: message,
      server: row ?? server,
    };
  }
}

/**
 * Enqueue `bot:capabilities` for every bot bound to a server.
 * @param mcpServerId - The server.
 */
export async function enqueueCapabilitiesForServer(
  mcpServerId: number,
): Promise<void> {
  const rows = await api.db.db
    .select({ botId: botMcpServers.botId })
    .from(botMcpServers)
    .where(eq(botMcpServers.mcpServerId, mcpServerId));
  for (const { botId } of rows) await enqueueCapabilities(botId);
}

/**
 * Enqueue the regeneration of one bot's capabilities summary.
 * @param botId - The bot.
 */
export async function enqueueCapabilities(botId: number): Promise<void> {
  await api.actions.enqueue("bot:capabilities", { botId }, "default");
}

/** One tool a bot can see, with whether calling it waits for a person. */
export interface VisibleTool {
  server: string;
  tool: McpCatalogTool;
  gated: boolean;
}

/**
 * Every tool a bot can see, in server then tool order.
 * @param servers - The bot's servers.
 * @returns The tools.
 */
export function visibleTools(servers: BotServer[]): VisibleTool[] {
  return servers.flatMap(({ server, binding }) =>
    server.toolsCache.map((tool) => ({
      server: server.name,
      tool,
      gated: !allowance(binding, server.name, tool).allowed,
    })),
  );
}

/**
 * The text a tool is searched and embedded by: its name with separators as
 * spaces, its title, and its description.
 * @param server - The server's name.
 * @param tool - The tool.
 * @returns The text.
 */
export function toolSearchText(server: string, tool: McpCatalogTool): string {
  const name = `${server} ${tool.name}`.replace(/[_\-./]+/g, " ");
  return [name, tool.title ?? "", tool.description].join("\n").trim();
}

/** One search hit. */
export interface CatalogHit extends VisibleTool {
  score: number;
}

/**
 * The keyword ranks of a list of texts against a query, by Postgres's
 * `ts_rank_cd` over any of the query's words (as memory search ranks).
 * @param texts - The texts, in order.
 * @param query - The query.
 * @returns Indexes into `texts` that match, best first.
 */
async function keywordRanks(texts: string[], query: string): Promise<number[]> {
  if (texts.length === 0) return [];
  const tsquery = sql`nullif(replace(plainto_tsquery('english', ${query})::text, '&', '|'), '')::tsquery`;
  const result = await api.db.db.execute(sql`
    select t.ord::int - 1 as i,
      ts_rank_cd(to_tsvector('english', t.body), ${tsquery}) as score
    from unnest(array[${sql.join(
      texts.map((t) => sql`${t}::text`),
      sql`, `,
    )}]) with ordinality as t(body, ord)
    where to_tsvector('english', t.body) @@ ${tsquery}
    order by score desc, t.ord`);
  return (result.rows as { i: number }[]).map((r) => Number(r.i));
}

/**
 * Cosine similarity of two vectors.
 * @param a - One.
 * @param b - The other.
 * @returns The similarity.
 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * The semantic ranks of a list of texts against a query, embedding what the
 * Redis cache does not hold. `null` when the project has no embedding model or
 * it cannot be reached; search then uses keywords alone.
 * @param projectId - The project.
 * @param texts - The texts.
 * @param query - The query.
 * @param signal - Aborts the embedding calls.
 * @returns Indexes into `texts`, nearest first, or `null`.
 */
async function semanticRanks(
  projectId: number,
  texts: string[],
  query: string,
  signal?: AbortSignal,
): Promise<number[] | null> {
  if (texts.length === 0) return [];
  const model = await embeddingModel(projectId);
  if (!model) return null;
  const keys = texts.map(
    (t) =>
      `hyp:mcp-embed:${model.revision}:${createHash("sha256").update(t).digest("hex")}`,
  );
  try {
    const cached = await api.redis.redis.mget(...keys);
    const missing = cached.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    const vectors: (number[] | null)[] = cached.map((v) =>
      v ? (JSON.parse(v) as number[]) : null,
    );
    const toEmbed = [query, ...missing.map((i) => texts[i])];
    const { embeddings } = await embedMany({
      model: model.model,
      values: toEmbed,
      maxRetries: 1,
      abortSignal: signal,
      dimensions: MEMORY_EMBEDDING_DIMENSIONS,
    });
    const [queryVector, ...fresh] = embeddings;
    for (const [j, i] of missing.entries()) {
      vectors[i] = fresh[j];
      await api.redis.redis.set(
        keys[i],
        JSON.stringify(fresh[j]),
        "EX",
        7 * 24 * 60 * 60,
      );
    }
    return vectors
      .map((v, i) => ({ i, s: v ? cosine(queryVector, v) : -1 }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((r) => r.i);
  } catch (error) {
    if (signal?.aborted) throw error;
    api.logger.warn("MCP tool search could not embed", {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Search a bot's tools: keyword and semantic ranks fused by weighted RRF.
 * Without an embedding model, keyword alone; and a query that matches no
 * keyword still returns the semantic order.
 * @param projectId - The project.
 * @param servers - The bot's servers.
 * @param query - What the bot is looking for.
 * @param limit - How many hits.
 * @param signal - Aborts the embedding calls.
 * @returns The hits, best first, and whether semantic ranking took part.
 */
export async function searchCatalog(
  projectId: number,
  servers: BotServer[],
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ hits: CatalogHit[]; semantic: boolean }> {
  const tools = visibleTools(servers);
  const texts = tools.map((t) => toolSearchText(t.server, t.tool));
  const [keyword, semantic] = await Promise.all([
    keywordRanks(texts, query),
    semanticRanks(projectId, texts, query, signal),
  ]);
  const k = config.memory.rrfK;
  const sw = semantic ? config.memory.semanticWeight : 0;
  const scores = new Map<number, number>();
  keyword.forEach((i, rank) => {
    scores.set(i, (scores.get(i) ?? 0) + (1 - sw) / (k + rank + 1));
  });
  semantic?.forEach((i, rank) => {
    scores.set(i, (scores.get(i) ?? 0) + sw / (k + rank + 1));
  });
  const max = 1 / (k + 1);
  const hits = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([i, s]) => ({
      ...tools[i],
      score: Math.round((s / max) * 1000) / 1000,
    }));
  return { hits, semantic: semantic !== null };
}

/**
 * Every server id a set of bindings names.
 * @param db - A database handle.
 * @param ids - Server ids.
 * @returns The rows.
 */
export async function serversByIds(
  db: DbHandle,
  ids: number[],
): Promise<McpServer[]> {
  if (ids.length === 0) return [];
  return db.select().from(mcpServers).where(inArray(mcpServers.id, ids));
}
