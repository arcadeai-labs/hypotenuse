import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  actingBot,
  actingJob,
  type JobConnection,
  JobTokenMiddleware,
  JobTokenRateLimitMiddleware,
} from "../../middleware/jobToken";
import { scopeFor } from "../../ops/MemoryOps";
import { searchMemory } from "../../ops/MemorySearchOps";
import { jobTokenInput } from "../../ops/SandboxInputOps";
import { parentOf, touchJobActivity } from "../../ops/SandboxJobOps";

/**
 * `sandbox:memory-search` — the bot's memory, read-only, in the scopes of the
 * conversation the job belongs to: its channel's memory and the project's.
 * The scope comes from the job's row, never from the input. Job token only;
 * not audited (it reads).
 */
export class SandboxMemorySearch implements Action {
  name = "sandbox:memory-search";
  description =
    "Search what the bot that sent you remembers about this channel and this project: decisions, conventions, people, past work. Read-only. Returns snippets ranked by meaning and keywords.";
  middleware = [JobTokenMiddleware, JobTokenRateLimitMiddleware];
  web = { route: "/sandbox/job/memory", method: HTTP_METHOD.GET };
  inputs = z.object({
    token: jobTokenInput,
    query: z.string().trim().min(1).max(500).describe("What to find, in words"),
    scope: z
      .enum(["channel", "project", "both"])
      .optional()
      .describe("Where to look (default both)"),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(25)
      .optional()
      .describe("How many hits, at most 25 (default 10)"),
  });

  /**
   * @param params - The query.
   * @param connection - The job's connection.
   * @returns The hits.
   */
  async run(
    params: ActionParams<SandboxMemorySearch>,
    connection: JobConnection,
  ) {
    const job = actingJob(connection);
    const bot = actingBot(connection);
    const conversation = await parentOf(api.db.db, job);
    if (!conversation) return { hits: [], mode: "keyword" as const };
    await touchJobActivity(api.db.db, job.id);
    const result = await searchMemory(
      api.db.db,
      scopeFor(conversation, bot),
      params.query,
      { scope: params.scope ?? "both", limit: params.limit ?? 10 },
    );
    return {
      hits: result.hits.map((h) => ({
        path: h.path,
        scope: h.scope,
        snippet: h.snippet,
        score: h.score,
        description: h.description,
      })),
      mode: result.mode,
    };
  }
}
