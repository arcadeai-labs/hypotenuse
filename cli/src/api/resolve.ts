/**
 * Turning what a person types into ids. An organization or a project is named
 * by id or slug; a slug is looked up through `organization:list` or
 * `project:list`, which list only the caller's own, so a slug can never reach
 * something the caller is not in.
 */
import type { ApiClient } from "./client";

/** A caller's standing in a project, as the server decides it. */
export interface ProjectStanding {
  isMember: boolean;
  isAdmin: boolean;
  viaOrganizationOwner: boolean;
}

/** A project as `project:list` answers it. */
export interface ProjectSummary {
  id: number;
  organizationId: number;
  name: string;
  slug: string;
  createdAt: number;
  updatedAt: number;
  standing?: ProjectStanding;
}

/** A caller's standing in an organization. */
export interface OrganizationStanding {
  isMember: boolean;
  isOwner: boolean;
  role: "owner" | "member";
}

/** An organization as `organization:list` answers it. */
export interface OrganizationSummary {
  id: number;
  name: string;
  slug: string;
  createdAt: number;
  updatedAt: number;
  standing?: OrganizationStanding;
}

/**
 * Walk every page of a list action until `match` finds a row.
 * @param client - A signed-in client.
 * @param path - The list route.
 * @param key - The named collection in the answer.
 * @param match - Whether a row is the one wanted.
 * @returns The row, or null when no page has it.
 */
export async function findInPages<T>(
  client: ApiClient,
  path: string,
  key: string,
  match: (row: T) => boolean,
): Promise<T | null> {
  for (let page = 1; ; page++) {
    const body = await client.request<
      Record<string, unknown> & { pagination: { pages: number } }
    >("GET", path, { query: { page, limit: 100 } });
    const found = (body[key] as T[]).find(match);
    if (found) return found;
    if (page >= body.pagination.pages) return null;
  }
}

/**
 * Resolve a project id or slug to a project the caller belongs to.
 * @param client - A signed-in client.
 * @param selector - An id (all digits) or a slug.
 * @returns The project's id.
 * @throws {Error} When no project of the caller's has that slug.
 */
export async function resolveProjectId(
  client: ApiClient,
  selector: string,
): Promise<number> {
  if (/^\d+$/.test(selector)) return Number(selector);
  const match = await findInPages<ProjectSummary>(
    client,
    "/projects",
    "projects",
    (p) => p.slug === selector,
  );
  if (!match)
    throw new Error(`You have no project with the slug "${selector}"`);
  return match.id;
}

/**
 * Resolve an organization id or slug to one the caller belongs to.
 * @param client - A signed-in client.
 * @param selector - An id (all digits) or a slug.
 * @returns The organization's id.
 * @throws {Error} When no organization of the caller's has that slug.
 */
export async function resolveOrganizationId(
  client: ApiClient,
  selector: string,
): Promise<number> {
  if (/^\d+$/.test(selector)) return Number(selector);
  const match = await findInPages<OrganizationSummary>(
    client,
    "/organizations",
    "organizations",
    (o) => o.slug === selector,
  );
  if (!match) {
    throw new Error(`You have no organization with the slug "${selector}"`);
  }
  return match.id;
}

/**
 * The caller's only row of a list, so a command needs no selector until there
 * is a choice to make.
 * @param client - A signed-in client.
 * @param path - The list route.
 * @param key - The named collection in the answer.
 * @returns The row, or null with none or several, and how many there are.
 */
export async function onlyOne<T>(
  client: ApiClient,
  path: string,
  key: string,
): Promise<{ only: T | null; total: number }> {
  const body = await client.request<
    Record<string, unknown> & { pagination: { total: number } }
  >("GET", path, { query: { page: 1, limit: 2 } });
  const rows = body[key] as T[];
  return {
    only: body.pagination.total === 1 ? (rows[0] ?? null) : null,
    total: body.pagination.total,
  };
}

/**
 * Resolve a bot id or slug in a project to a bot the caller can read.
 * @param client - A signed-in client.
 * @param projectId - The project.
 * @param selector - An id (all digits) or a slug.
 * @returns The bot's id.
 * @throws {Error} When no bot the caller can read has that slug.
 */
export async function resolveBotId(
  client: ApiClient,
  projectId: number,
  selector: string,
): Promise<number> {
  if (/^\d+$/.test(selector)) return Number(selector);
  const match = await findInPages<{ id: number; slug: string }>(
    client,
    `/project/${projectId}/bots`,
    "bots",
    (b) => b.slug === selector,
  );
  if (!match) throw new Error(`No bot with the slug "${selector}"`);
  return match.id;
}

/**
 * Resolve a model connection id or name in a project.
 * @param client - A signed-in client.
 * @param projectId - The project.
 * @param selector - An id (all digits) or the connection's name.
 * @returns The connection's id.
 * @throws {Error} When no connection has that name.
 */
export async function resolveConnectionId(
  client: ApiClient,
  projectId: number,
  selector: string,
): Promise<number> {
  if (/^\d+$/.test(selector)) return Number(selector);
  const match = await findInPages<{ id: number; name: string }>(
    client,
    `/project/${projectId}/model-connections`,
    "modelConnections",
    (c) => c.name === selector,
  );
  if (!match) throw new Error(`No model connection named "${selector}"`);
  return match.id;
}
