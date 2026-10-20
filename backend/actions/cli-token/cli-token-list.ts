import { and, count, desc, eq, isNull } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import type { RbacConnectionMeta } from "../../middleware/rbac";
import { type SessionImpl, SessionMiddleware } from "../../middleware/session";
import { serializeCliToken } from "../../ops/CliTokenOps";
import { cliTokens } from "../../schema/cli_tokens";

/**
 * `cli-token:list` — the caller's own CLI sign-ins that have not been revoked,
 * newest first: the Account page's "CLI sign-ins" section. Expired ones are
 * listed with `status: "expired"` so a person can see a machine lapsed.
 */
export class CliTokenList implements Action {
  name = "cli-token:list";
  description =
    "List your own hypotenuse CLI sign-ins (device, created, last used, expiry), newest first. Revoked sign-ins are omitted. Paginated.";
  middleware = [SessionMiddleware];
  web = { route: "/cli-tokens", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 });

  /**
   * @param params - Pagination inputs.
   * @param connection - The caller's connection.
   * @returns The caller's CLI tokens plus pagination metadata.
   */
  async run(
    params: ActionParams<CliTokenList>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const where = and(
      eq(cliTokens.userId, connection.session!.data.userId!),
      isNull(cliTokens.revokedAt),
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(cliTokens)
        .where(where)
        .orderBy(desc(cliTokens.createdAt), desc(cliTokens.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(cliTokens).where(where),
      params,
    );
    const principal = connection.metadata.principal;
    const currentId =
      principal?.kind === "cli" ? principal.cliTokenId : undefined;
    return {
      cliTokens: result.data.map((row) => serializeCliToken(row, currentId)),
      pagination: result.pagination,
    };
  }
}
