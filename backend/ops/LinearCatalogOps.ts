import { api, config } from "keryx";
import type { Integration } from "../schema/integrations";
import { linearRequest } from "./LinearOps";
import {
  ListLabels,
  ListProjects,
  ListTeams,
  type PageInfo,
} from "./linear/operations";

/**
 * The pickers every routing and subscription form needs — teams with their
 * workflow states, projects, labels — read from Linear server-side so no client
 * ever holds a Linear token to fill a dropdown.
 */

/** What `integration:catalog` answers. */
export interface LinearCatalog {
  teams: {
    id: string;
    key: string;
    name: string;
    states: { id: string; name: string; type: string; position: number }[];
  }[];
  projects: { id: string; name: string; teamIds: string[] }[];
  labels: { id: string; name: string; teamId: string | null }[];
}

/** The most pages any one list is read to, so a huge workspace cannot loop forever. */
const MAX_PAGES = 20;

/** The Redis key one integration's catalog is cached under. */
export const catalogKey = (integrationId: number) =>
  `linear:catalog:${integrationId}`;

/**
 * Read every page of one connection.
 * @param page - Reads one page from a cursor.
 * @returns Every node.
 */
async function readAll<N>(
  page: (after: string | null) => Promise<{ nodes: N[]; pageInfo: PageInfo }>,
): Promise<N[]> {
  const nodes: N[] = [];
  let after: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const result = await page(after);
    nodes.push(...result.nodes);
    if (!result.pageInfo.hasNextPage || !result.pageInfo.endCursor) break;
    after = result.pageInfo.endCursor;
  }
  return nodes;
}

/**
 * Read the catalog straight from Linear.
 * @param integration - The integration to read as.
 * @returns Teams, projects, and labels the app user can see.
 */
async function fetchCatalog(integration: Integration): Promise<LinearCatalog> {
  const idempotent = { idempotent: true };
  const [teams, projects, labels] = await Promise.all([
    readAll(async (after) => {
      const data = await linearRequest(
        integration,
        ListTeams,
        { after },
        idempotent,
      );
      return data.teams;
    }),
    readAll(async (after) => {
      const data = await linearRequest(
        integration,
        ListProjects,
        { after },
        idempotent,
      );
      return data.projects;
    }),
    readAll(async (after) => {
      const data = await linearRequest(
        integration,
        ListLabels,
        { after },
        idempotent,
      );
      return data.issueLabels;
    }),
  ]);

  return {
    teams: teams.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      states: [...t.states.nodes].sort((a, b) => a.position - b.position),
    })),
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      teamIds: p.teams.nodes.map((t) => t.id),
    })),
    labels: labels.map((l) => ({
      id: l.id,
      name: l.name,
      teamId: l.team?.id ?? null,
    })),
  };
}

/**
 * The integration's catalog, from Redis when it was read within
 * `catalogTtlMs`, else from Linear (and then cached).
 * @param integration - The integration to read as.
 * @returns The catalog.
 */
export async function loadCatalog(
  integration: Integration,
): Promise<LinearCatalog> {
  const cached = await api.redis.redis.get(catalogKey(integration.id));
  if (cached) return JSON.parse(cached) as LinearCatalog;
  const catalog = await fetchCatalog(integration);
  await api.redis.redis.set(
    catalogKey(integration.id),
    JSON.stringify(catalog),
    "PX",
    config.linear.catalogTtlMs,
  );
  return catalog;
}
