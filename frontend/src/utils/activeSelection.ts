/** localStorage key for the organization last chosen in the switcher. */
export const ACTIVE_ORGANIZATION_KEY = "hypotenuse.activeOrganizationId";

/** localStorage key for the project last chosen in the switcher. */
export const ACTIVE_PROJECT_KEY = "hypotenuse.activeProjectId";

/**
 * Keep a stored selection only while it is still one of the choices; otherwise
 * fall back to the first. An organization can be left, a project deleted, and
 * the browser may last have been signed in as somebody else — a stale id must
 * heal itself, never name a tenant the server would refuse.
 * @param stored - The id the browser remembers, or null.
 * @param ids - The ids the server says are available, in display order.
 * @returns The id to make active, or null when there are none.
 */
export function pickActive(
  stored: number | null,
  ids: readonly number[],
): number | null {
  if (stored !== null && ids.includes(stored)) return stored;
  return ids[0] ?? null;
}

/**
 * Read a remembered id. Unavailable storage (a server render, a locked-down
 * browser) reads as nothing remembered.
 * @param key - The localStorage key.
 * @returns The id, or null.
 */
export function readStoredId(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    const id = raw ? Number(raw) : Number.NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Remember an id, or forget it with `null`. Unavailable storage only costs
 * persistence.
 * @param key - The localStorage key.
 * @param id - The id, or null to forget.
 */
export function writeStoredId(key: string, id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(id));
  } catch {
    // Persistence is a convenience.
  }
}
