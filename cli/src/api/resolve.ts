/**
 * Turning what a person types into ids. A project is named by id or slug; a
 * slug is looked up through `project:list`, which only lists the caller's own
 * projects, so a slug can never reach a project the caller is not in.
 */
import type { ApiClient } from "./client";

/** A project as `project:list` answers it. */
export interface ProjectSummary {
  id: number;
  name: string;
  slug: string;
  createdAt: number;
  updatedAt: number;
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
  for (let page = 1; ; page++) {
    const { projects, pagination } = await client.request<{
      projects: ProjectSummary[];
      pagination: { pages: number };
    }>("GET", "/projects", { query: { page, limit: 100 } });
    const match = projects.find((p) => p.slug === selector);
    if (match) return match.id;
    if (page >= pagination.pages) {
      throw new Error(`You have no project with the slug "${selector}"`);
    }
  }
}
