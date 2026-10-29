/** What a bot's own access list adds to a refusal the RBAC map did not make. */
export const BOT_WRITE_DENIED =
  "Your tags do not include one of this bot's write access tags. Ask someone who holds one, or an admin.";

/**
 * Why a person may not change a bot, or `undefined` when they may.
 *
 * Two answers decide it, both the server's: what the action requires
 * (`can()`, through `useMay().reason`) and the bot's own access list, which
 * the server reports per bot as `standing.canWrite`. The client re-implements
 * neither.
 * @param actionReason - `reason(action)` for the action, e.g. `bot:edit`.
 * @param standing - The bot's `standing` from `bot:view` or `bot:list`, or `null` while unknown.
 * @returns The sentence a disabled control carries, or `undefined`.
 */
export function botWriteDenied(
  actionReason: string | undefined,
  standing: { canWrite: boolean } | null,
): string | undefined {
  if (actionReason) return actionReason;
  // Unknown is not a refusal: the page has not been told yet.
  if (standing && !standing.canWrite) return BOT_WRITE_DENIED;
  return undefined;
}

/** The two names every project must define before any bot can run. */
export const REQUIRED_MODEL_ALIASES = ["default", "fast"] as const;

/**
 * The sentence the Bots page shows while required model names are missing.
 * @param missing - `model-alias:list`'s `missingRequired`.
 * @returns The sentence, or `null` when nothing is missing.
 */
export function missingAliasesSentence(
  missing: readonly string[],
): string | null {
  if (missing.length === 0) return null;
  const names = missing.map((name) => `"${name}"`);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const noun = names.length === 1 ? "model name" : "model names";
  return `This project needs the ${list} ${noun} before any bot can run.`;
}
