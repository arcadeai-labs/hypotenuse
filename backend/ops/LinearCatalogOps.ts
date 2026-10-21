import { api, config } from "keryx";
import type { LinearInstallation } from "../schema/linear_installations";
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

/** What `linear:catalog` answers. */
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

/** The Redis key one installation's catalog is cached under. */
export const catalogKey = (installationId: number) =>
  `linear:catalog:${installationId}`;

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
 * @param installation - The installation to read as.
 * @returns Teams, projects, and labels the app user can see.
 */
async function fetchCatalog(
  installation: LinearInstallation,
): Promise<LinearCatalog> {
  const idempotent = { idempotent: true };
  const [teams, projects, labels] = await Promise.all([
    readAll(async (after) => {
      const data = await linearRequest(
        installation,
        ListTeams,
        { after },
        idempotent,
      );
      return data.teams;
    }),
    readAll(async (after) => {
      const data = await linearRequest(
        installation,
        ListProjects,
        { after },
        idempotent,
      );
      return data.projects;
    }),
    readAll(async (after) => {
      const data = await linearRequest(
        installation,
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
 * The installation's catalog, from Redis when it was read within
 * `catalogTtlMs`, else from Linear (and then cached).
 * @param installation - The installation to read as.
 * @returns The catalog.
 */
export async function loadCatalog(
  installation: LinearInstallation,
): Promise<LinearCatalog> {
  const cached = await api.redis.redis.get(catalogKey(installation.id));
  if (cached) return JSON.parse(cached) as LinearCatalog;
  const catalog = await fetchCatalog(installation);
  await api.redis.redis.set(
    catalogKey(installation.id),
    JSON.stringify(catalog),
    "PX",
    config.linear.catalogTtlMs,
  );
  return catalog;
}
